require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const app  = express();
const PORT = 3030;

app.use(cors({
  origin: ['http://localhost:3030', 'http://127.0.0.1:3030', 'null', '*'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json({ limit: '50mb' }));

// ── Check auth mode ────────────────────────────────────────────────────────
// Priority: ANTHROPIC_API_KEY (in .env) > claude CLI OAuth (subscription)
const API_KEY = process.env.ANTHROPIC_API_KEY || null;
const USE_CLI = !API_KEY;

// ── Whisper config (configurable via .env) ────────────────────────────────
const WHISPER_BIN   = process.env.WHISPER_BIN   || '/Library/Frameworks/Python.framework/Versions/3.14/bin/whisper';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'base';
const WHISPER_LANG  = process.env.WHISPER_LANG  || 'en';

if (API_KEY) {
  console.log('✓  Mode: Anthropic API key');
} else {
  console.log('✓  Mode: Claude subscription (OAuth via CLI)');
  console.log('   Make sure you ran: claude auth login  (from a regular Terminal)');
}
console.log('✓  Whisper:', WHISPER_BIN, '| model:', WHISPER_MODEL, '| lang:', WHISPER_LANG);

// ── Clean environment for claude CLI subprocess ────────────────────────────
const STRIP_VARS = [
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
  'CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL',
  'CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES',
  'CLAUDE_CODE_DISABLE_CRON',
  'BAGGAGE',
];

function cleanEnv() {
  const env = { ...process.env };
  for (const v of STRIP_VARS) delete env[v];
  env.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:' + (env.PATH || '');
  return env;
}

// ── System prompt ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an AI assistant embedded inside Adobe Premiere Pro.
Your PRIMARY job is parsing cutsheets into the \`cutlist\` action. The plugin does
everything else (STT, alignment, video placement) deterministically — you do NOT.

═══════════════════════════════════════════════════════════════════════════
PRIORITY RULE — when user attaches a cutsheet image/text:
  1. ALWAYS emit a single \`cutlist\` action with all rows
  2. NEVER use cut_clip, trim_clip, move_clip — those are for explicit manual edits
  3. DO NOT analyze the voiceover, do STT, compute timings — the plugin does that
  4. DO NOT ask clarifying questions — parse with best interpretation
  5. Briefly explain assumptions in text after the action block
═══════════════════════════════════════════════════════════════════════════

When you need to perform actions, include a JSON block:
\`\`\`actions
[
  {"action": "action_name", ...params}
]
\`\`\`

PRIMARY ACTION (use this for ALL cutsheet inputs):
- cutlist  {rows: [{source, sourceIn, sourceOut, script}, ...]}

Available manual-edit actions (rarely needed — only when user explicitly asks):
- get_timeline_info                                              → read sequence info
- add_subtitle   {text, startTime, endTime, captionTrackIndex?} → add caption
- add_marker     {time, name, color?}                           → add marker
- cut_clip       {trackIndex, clipIndex, time}                  → razor cut existing clip
- move_clip      {trackIndex, clipIndex, newStart}              → move clip
- trim_clip      {trackIndex, clipIndex, newIn, newOut}         → trim clip
- apply_effect   {trackIndex, clipIndex, effectName}            → apply effect
- set_volume     {trackIndex, clipIndex, volumeDb}              → set volume
- voicegen_script {text, voiceId?, autoGenerate?}              → push script to Voice Gen tab (auto-switch)
- voicegen_sfx   {text, autoGenerate?}                         → push SFX prompt to Voice Gen tab

── VOICE GEN INTEGRATION ────────────────────────────────────────────────
When the user asks you to:
  • "Generate a voiceover for..." / "Read this script..." / "Create a narration..."
    → emit a voicegen_script action with the script text
    → set autoGenerate: true to start generation immediately
  • "Create a sound effect for..." / "Generate SFX..."
    → emit a voicegen_sfx action
  • You can also specify a voiceId from known ElevenLabs IDs (optional)
  • These actions auto-switch the plugin to the Voice Gen tab

── AUTOCUT CUTLIST PARSING ──────────────────────────────────────────────
When the user attaches a cutsheet (image OR text), parse to \`cutlist\` action.

Format:
\`\`\`actions
[
  {"action": "cutlist",
   "rows": [
     {"source": "k11 o1",   "sourceIn": 2.0, "sourceOut": 8.0, "script": "Oh my gosh..."},
     {"source": "k11.1 o2", "sourceIn": 1.0, "sourceOut": 7.0, "script": "Honestly?..."},
     {"source": "Senyue 46","sourceIn": 0.0, "sourceOut": 1.0, "script": "Easy front closure"},
     {"source": "Senyue 99","sourceIn": 0.0, "sourceOut": 1.0, "script": "Easy front closure"}
   ]}
]
\`\`\`

Parsing rules:
1. Each row = one (source clip, in/out, script line) tuple.
2. Timecode conversion to SECONDS:
   - "0:02-0:08"  → sourceIn=2.0, sourceOut=8.0
   - "0:01"       → sourceIn=1.0, sourceOut=2.0  (default duration = 1s when only start given)
   - "00:01:30:15" (HH:MM:SS:FF, assume 30fps) → in seconds
3. Merged cells:
   - One script line with multiple sources → emit MULTIPLE rows, each row gets the SAME script text
     (the cut for that script line plays sequentially across all listed sources).
   - One source with multiple script lines → emit MULTIPLE rows with the SAME sourceIn/sourceOut
     (the source clip is played once but is paired with all those script lines).
4. The "source" field MUST be the exact text the user wrote in the source column (don't normalize).
   The plugin does fuzzy matching against the Premiere Project Panel and sequence list.
5. Always include the cutlist action when user shares a cutsheet, even if some rows are ambiguous.
6. Explain your parsing briefly in text alongside the action.

Always explain what you are doing in text alongside any actions.`;

// ── POST /chat — streaming SSE ─────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const { messages = [], timelineContext, model, apiKey, voiceContext } = req.body;

  // Per-request key takes priority over env key (so plugin can supply user's key)
  const effectiveKey = apiKey || API_KEY;
  if (effectiveKey) {
    await chatViaApiKey(req, res, messages, timelineContext, model, effectiveKey, voiceContext);
  } else {
    await chatViaCLI(req, res, messages, timelineContext, voiceContext);
  }
});

// ── Convert plugin message format to Anthropic SDK content blocks ────────
// Plugin sends: { role, content: string | [{type:'text',text}|{type:'image',mediaType,data,name}] }
// Anthropic expects: { role, content: string | [{type:'text',text}|{type:'image',source:{type:'base64',media_type,data}}] }
function toAnthropicMessage(m) {
  const role = m.role === 'user' ? 'user' : 'assistant';
  if (typeof m.content === 'string') return { role, content: m.content };
  if (!Array.isArray(m.content)) return { role, content: String(m.content || '') };
  const blocks = m.content.map(p => {
    if (p.type === 'image') {
      return {
        type: 'image',
        source: { type: 'base64', media_type: p.mediaType || 'image/png', data: p.data },
      };
    }
    if (p.type === 'text')  return { type: 'text', text: p.text || '' };
    return p;
  });
  return { role, content: blocks };
}

// ── Default model (override by client per-request via `model` field) ─────
// Claude 4.x family — all support vision:
//   claude-opus-4-7        (best quality, slowest, most expensive)
//   claude-sonnet-4-6      (recommended default — fast + good vision)
//   claude-haiku-4-5       (fastest + cheapest, weaker reasoning)
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

// ── Mode A: Direct Anthropic API key ──────────────────────────────────────
async function chatViaApiKey(req, res, messages, timelineContext, model, apiKey, voiceContext) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: apiKey });

  let systemContent = SYSTEM_PROMPT;
  if (timelineContext) systemContent += `\n\n[Current Timeline]\n${JSON.stringify(timelineContext, null, 2)}`;
  if (voiceContext)    systemContent += `\n\n── Available ElevenLabs Voices ──\nWhen the user asks you to pick a voice or generate speech, choose the most appropriate voiceId from this list:\n${voiceContext}\nUse the voiceId (the part before the colon) in your voicegen_script action.`;

  const useModel = model || DEFAULT_MODEL;
  console.log(`[chat] model: ${useModel}, messages: ${messages.length}`);

  try {
    const stream = await client.messages.stream({
      model:      useModel,
      max_tokens: 4096,
      system:     systemContent,
      messages:   messages.map(toAnthropicMessage),
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        send(res, { type: 'text', content: event.delta.text });
      }
    }
    send(res, { type: 'done' });
  } catch (err) {
    send(res, { type: 'error', content: `API Error: ${err.message}` });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

// ── Convert plugin message to CLI prompt text + temp image files ─────────
// The Claude Code CLI supports image references via `@path` (e.g. `@/tmp/foo.png`).
// We save base64 images to a temp dir and inject "@<path>" tokens into the prompt.
function messageToCliText(m, tmpDir) {
  if (m == null) return '';
  if (typeof m.content === 'string') return m.content;

  // Defensive: handle anything that isn't a proper content array
  if (!Array.isArray(m.content)) {
    if (m.content && typeof m.content === 'object') {
      // Single content object → try to extract sensibly
      if (m.content.text) return String(m.content.text);
      if (m.content.type === 'image') return imagePartToToken(m.content, tmpDir, 0);
    }
    return String(m.content || '');
  }

  const parts = [];
  m.content.forEach((p, idx) => {
    if (!p || typeof p !== 'object') {
      // Stray primitive → just stringify it
      if (p != null) parts.push(String(p));
      return;
    }
    // Detect image by type OR by presence of base64 data field
    if (p.type === 'image' || (p.data && (p.mediaType || p.media_type))) {
      const token = imagePartToToken(p, tmpDir, idx);
      if (token) parts.push(token);
    } else if (p.type === 'text' || p.text) {
      parts.push(String(p.text || ''));
    } else {
      // Unknown block type — log and skip (don't poison prompt with [object Object])
      console.warn('[cli] unknown content part:', JSON.stringify(p).slice(0, 80));
    }
  });
  return parts.join(' ');
}

function imagePartToToken(p, tmpDir, idx) {
  const mediaType = p.mediaType || p.media_type || 'image/png';
  const ext = mediaType.split('/')[1] || 'png';
  const name = `attach-${Date.now()}-${idx}.${ext}`;
  const fpath = path.join(tmpDir, name);
  try {
    fs.writeFileSync(fpath, Buffer.from(p.data, 'base64'));
    return `@${fpath}`;
  } catch (e) {
    console.warn('[cli] cannot write image:', e.message);
    return '';
  }
}

// ── Mode B: claude CLI subprocess (OAuth subscription) ───────────────────
function chatViaCLI(req, res, messages, timelineContext, voiceContext) {
  return new Promise((resolve) => {
    // CRITICAL: write attachments INSIDE bridge dir so Claude Code CLI can
    // read them (its sandbox is rooted at its cwd). OS tmpdir (/var/folders/...)
    // is outside the workspace and triggers permission prompts.
    const bridgeDir   = __dirname;
    const attachRoot  = path.join(bridgeDir, '.attachments');
    try { fs.mkdirSync(attachRoot, { recursive: true }); } catch {}
    const tmpDir = fs.mkdtempSync(path.join(attachRoot, 'turn-'));
    const cleanupTmp = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} };

    let prompt = SYSTEM_PROMPT;
    if (timelineContext) prompt += `\n\n[Current Timeline]\n${JSON.stringify(timelineContext, null, 2)}`;
    if (voiceContext)    prompt += `\n\n── Available ElevenLabs Voices ──\nWhen the user asks you to pick a voice or generate speech, choose the most appropriate voiceId from this list:\n${voiceContext}\nUse the voiceId (the part before the colon) in your voicegen_script action.`;
    prompt += '\n\n';
    for (const m of messages) {
      const text = messageToCliText(m, tmpDir);
      prompt += m.role === 'user' ? `Human: ${text}\n\n` : `Assistant: ${text}\n\n`;
    }
    prompt += 'Assistant:';

    // Spawn claude with cwd = bridgeDir so @<path> tokens that point inside
    // bridge/.attachments/ are within its sandbox and don't require permission.
    // --add-dir explicitly whitelists the attachments folder for read access.
    const proc = spawn('claude', [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--add-dir', attachRoot,
      '--permission-mode', 'bypassPermissions',
    ], {
      cwd: bridgeDir,
      env: cleanEnv()
    });

    const startTime = Date.now();
    console.log(`[cli] spawned PID ${proc.pid}, prompt length ${prompt.length}`);

    proc.stdin.write(prompt);
    proc.stdin.end();

    // Heartbeat: send a non-text SSE event every 10s so the plugin xhr keeps
    // streaming and the user sees activity in the console.
    const heartbeat = setInterval(() => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`[cli] still running… ${elapsed}s`);
      send(res, { type: 'heartbeat', elapsed: Number(elapsed) });
    }, 10000);

    let buf = '';
    let textReceived = false;
    proc.stdout.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          // Verbose event types: system, user, assistant, result
          console.log(`[cli] event: ${ev.type}` +
            (ev.subtype ? `/${ev.subtype}` : '') +
            (ev.message?.content ? ` (${ev.message.content.length} blocks)` : ''));
          if (ev.type === 'assistant' && ev.message?.content) {
            for (const block of ev.message.content) {
              if (block.type === 'text') {
                send(res, { type: 'text', content: block.text });
                textReceived = true;
              } else if (block.type === 'tool_use') {
                console.log(`[cli]   tool_use: ${block.name}`);
                send(res, { type: 'tool_use', name: block.name });
              }
            }
          }
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            send(res, { type: 'text', content: ev.delta.text });
            textReceived = true;
          }
          if (ev.type === 'result' && ev.is_error) {
            console.error('[cli] result error:', ev.result || ev.error);
            send(res, { type: 'error', content: 'CLI error: ' + (ev.result || 'unknown') });
          }
          if (ev.type === 'rate_limit_event') {
            console.warn('[cli] RATE LIMITED — FULL EVENT JSON:');
            console.warn(JSON.stringify(ev, null, 2));
            // Try multiple known field names that Anthropic might use
            var resetSec = null;
            var source = null;
            // Direct fields
            for (var key of ['reset_in_seconds','retry_after','retryAfter','retry_after_seconds']) {
              if (ev[key] != null) { resetSec = Number(ev[key]); source = key; break; }
            }
            // Timestamp fields
            if (resetSec == null) {
              for (var k2 of ['reset_at','resetAt','reset_time','resets_at','resetTime']) {
                if (ev[k2]) {
                  var rt = new Date(ev[k2]).getTime();
                  if (!isNaN(rt) && rt > Date.now()) {
                    resetSec = Math.ceil((rt - Date.now()) / 1000);
                    source = k2;
                    break;
                  }
                }
              }
            }
            // Nested fields (e.g. ev.rate_limit, ev.data, ev.error)
            if (resetSec == null) {
              for (var nk of ['rate_limit','data','error','limit_info']) {
                var nested = ev[nk];
                if (nested && typeof nested === 'object') {
                  for (var kk in nested) {
                    if (/reset|retry/i.test(kk) && (typeof nested[kk] === 'number' || typeof nested[kk] === 'string')) {
                      var v = typeof nested[kk] === 'number' ? nested[kk] : new Date(nested[kk]).getTime();
                      if (typeof nested[kk] === 'string' && !isNaN(v) && v > Date.now()) {
                        resetSec = Math.ceil((v - Date.now()) / 1000);
                      } else if (typeof nested[kk] === 'number' && v < 86400) {
                        resetSec = v; // assume seconds
                      }
                      if (resetSec) { source = nk + '.' + kk; break; }
                    }
                  }
                }
                if (resetSec) break;
              }
            }
            send(res, {
              type: 'rate_limit',
              resetSec: resetSec,           // null if unknown
              resetAt: resetSec ? Date.now() + resetSec * 1000 : null,
              source:  source,              // which field we extracted from
              raw:     ev,                  // pass full event for diagnostic
              content: 'Claude subscription rate-limited.',
            });
          }
        } catch (e) {
          // Log non-JSON output (could be debug info)
          console.log(`[cli] non-json:`, line.slice(0, 200));
        }
      }
    });

    proc.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg) console.error('[cli-stderr]', msg);
    });

    proc.on('close', (code) => {
      clearInterval(heartbeat);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[cli] PID ${proc.pid} exited code ${code} after ${elapsed}s, textReceived=${textReceived}`);
      if (code !== 0 && code !== null) {
        send(res, { type: 'error', content: `Claude CLI exited (${code}) after ${elapsed}s. Check bridge logs.` });
      } else if (!textReceived) {
        send(res, { type: 'error', content: `Claude CLI returned no text after ${elapsed}s. Check bridge logs.` });
      }
      send(res, { type: 'done' });
      res.write('data: [DONE]\n\n');
      res.end();
      cleanupTmp();
      resolve();
    });

    proc.on('error', err => {
      clearInterval(heartbeat);
      console.error('[cli] spawn error:', err);
      send(res, { type: 'error', content: `Cannot start claude CLI: ${err.message}` });
      res.write('data: [DONE]\n\n');
      res.end();
      cleanupTmp();
      resolve();
    });

    res.on('close', () => {
      clearInterval(heartbeat);
      if (!proc.killed) {
        console.log(`[cli] client disconnected, killing PID ${proc.pid}`);
        proc.kill();
      }
      cleanupTmp();
    });
  });
}

function send(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /transcribe — STT for autocut voiceover alignment
//   backend = "whisper"  → spawn whisper CLI with --word_timestamps
//   backend = "premiere" → read .transcript file at body.transcriptPath
// Returns: { ok, words: [{text,start,end}], segments: [{start,end,text}] }
// ═══════════════════════════════════════════════════════════════════════════
app.post('/transcribe', async (req, res) => {
  const { backend = 'whisper', audioPath, transcriptPath, language } = req.body;

  try {
    let result;
    if (backend === 'whisper') {
      if (!audioPath) throw new Error('audioPath is required for whisper backend');
      if (!fs.existsSync(audioPath)) throw new Error(`Audio file not found: ${audioPath}`);
      result = await transcribeWhisper(audioPath, language);
    } else if (backend === 'premiere') {
      if (!transcriptPath) throw new Error('transcriptPath is required for premiere backend');
      if (!fs.existsSync(transcriptPath)) throw new Error(`Transcript file not found: ${transcriptPath}`);
      result = await transcribePremiereFile(transcriptPath);
    } else {
      throw new Error(`Unknown backend: ${backend}`);
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[transcribe]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Whisper model URLs (from openai/whisper source)
const WHISPER_MODEL_URLS = {
  'tiny.en':   'https://openaipublic.azureedge.net/main/whisper/models/d3dd57d32accea0b295c96e26691aa14d8822fac7d9d27d5dc00b4ca2826dd03/tiny.en.pt',
  'tiny':      'https://openaipublic.azureedge.net/main/whisper/models/65147644a518d12f04e32d6f3b26facc3f8dd46e7e3af0078e1ed52e8db74e6f/tiny.pt',
  'base.en':   'https://openaipublic.azureedge.net/main/whisper/models/25a8566e1d0c1e2231d1c762132cd20e0f96a85d16145c3a00adf5d1ac670ead/base.en.pt',
  'base':      'https://openaipublic.azureedge.net/main/whisper/models/ed3a0b6b1c0edf879ad9b11b1af5a0e6ab5db9205f891f668f8b0e6c6326e34e/base.pt',
  'small.en':  'https://openaipublic.azureedge.net/main/whisper/models/f953ad0fd29cacd07d5a9eda5624af0f6bcf2258be67c92b79389873d91e0872/small.en.pt',
  'small':     'https://openaipublic.azureedge.net/main/whisper/models/9ecf779972d90ba49c06d968637d720dd632c55bbf19c977b5d33a48ed5775c5/small.pt',
  'medium.en': 'https://openaipublic.azureedge.net/main/whisper/models/d7440d1dc186f76616474e0ff0b3b6b879abc9d1a4926b7adfa41db2d497ab4f/medium.en.pt',
  'medium':    'https://openaipublic.azureedge.net/main/whisper/models/345ae4da62f9b3d59415adc60127b97c714f32e89e936602e85993674d08dcb1/medium.pt',
};

// Pre-download whisper model to ~/.cache/whisper/ using Node https with SSL
// bypass — works around macOS Python's cert verification failure.
function ensureWhisperModel(modelName) {
  return new Promise((resolve, reject) => {
    const cacheDir = path.join(os.homedir(), '.cache', 'whisper');
    const modelPath = path.join(cacheDir, modelName + '.pt');

    if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 1024) {
      return resolve(modelPath);
    }

    const url = WHISPER_MODEL_URLS[modelName];
    if (!url) return reject(new Error(`Unknown whisper model: ${modelName}`));

    try { fs.mkdirSync(cacheDir, { recursive: true }); } catch {}

    console.log(`[whisper] Pre-downloading model "${modelName}" → ${modelPath}`);
    const https = require('https');
    const tmpPath = modelPath + '.tmp';
    const file = fs.createWriteStream(tmpPath);

    function fetchUrl(targetUrl) {
      https.get(targetUrl, {
        rejectUnauthorized: false,  // SSL bypass — same as PYTHONHTTPSVERIFY=0
      }, response => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          return fetchUrl(response.headers.location);
        }
        if (response.statusCode !== 200) {
          return reject(new Error(`Model download HTTP ${response.statusCode}`));
        }
        const total = parseInt(response.headers['content-length'] || '0', 10);
        let downloaded = 0;
        let lastLog = 0;
        response.on('data', chunk => {
          downloaded += chunk.length;
          const pct = total ? Math.floor((downloaded / total) * 100) : 0;
          if (pct - lastLog >= 10) {
            console.log(`[whisper] download ${pct}% (${(downloaded/1e6).toFixed(0)}/${(total/1e6).toFixed(0)} MB)`);
            lastLog = pct;
          }
        });
        response.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            fs.renameSync(tmpPath, modelPath);
            console.log(`[whisper] Model downloaded: ${modelPath}`);
            resolve(modelPath);
          });
        });
      }).on('error', err => {
        try { fs.unlinkSync(tmpPath); } catch {}
        reject(new Error(`Download failed: ${err.message}`));
      });
    }
    fetchUrl(url);
  });
}

async function transcribeWhisper(audioPath, language) {
  // First ensure model is cached locally — this avoids Python's SSL issue.
  try {
    await ensureWhisperModel(WHISPER_MODEL);
  } catch (e) {
    throw new Error(`Whisper model setup failed: ${e.message}`);
  }

  return new Promise((resolve, reject) => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
    const args = [
      audioPath,
      '--model',           WHISPER_MODEL,
      '--language',        language || WHISPER_LANG,
      '--word_timestamps', 'True',
      '--output_format',   'json',
      '--output_dir',      outDir,
      '--verbose',         'False',
      '--fp16',            'False',
    ];

    console.log('[whisper]', WHISPER_BIN, args.join(' '));
    const env = cleanEnv();
    env.PYTHONHTTPSVERIFY = '0';
    const proc = spawn(WHISPER_BIN, args, { env });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.stdout.on('data', d => process.stdout.write('[whisper] ' + d.toString()));

    proc.on('error', err => reject(new Error(`Cannot start whisper: ${err.message}`)));
    proc.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`whisper exit ${code}: ${stderr.slice(-400)}`));
      }
      try {
        const base = path.basename(audioPath, path.extname(audioPath));
        const jsonPath = path.join(outDir, base + '.json');
        const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

        const words = [];
        const segments = [];
        for (const seg of (raw.segments || [])) {
          segments.push({ start: seg.start, end: seg.end, text: (seg.text || '').trim() });
          for (const w of (seg.words || [])) {
            const text = (w.word || w.text || '').trim();
            if (text) words.push({ text, start: w.start, end: w.end });
          }
        }
        resolve({ words, segments, fullText: raw.text || '' });
      } catch (e) {
        reject(new Error('Failed to parse whisper output: ' + e.message));
      } finally {
        try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
      }
    });
  });
}

function transcribePremiereFile(transcriptPath) {
  return new Promise((resolve, reject) => {
    try {
      const raw = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
      const words = [];
      const segments = [];

      // Adobe Premiere transcript JSON has a few possible shapes; handle the
      // most common ones flexibly.
      const transcriptList = raw.transcripts || raw.transcript || (raw.results && raw.results.transcripts) || [];
      const list = Array.isArray(transcriptList) ? transcriptList : [transcriptList];

      for (const t of list) {
        const items = t.items || t.words || t.tokens || t.segments || [];
        for (const item of items) {
          const start = Number(item.start ?? item.startTime ?? item.from ?? 0);
          const end   = Number(item.end   ?? item.endTime   ?? item.to   ?? start);
          const text  = String(item.text  ?? item.word      ?? item.content ?? '').trim();
          if (!text) continue;
          words.push({ text, start, end });
        }
      }

      // Build coarse segments by clustering words separated by >0.5s gaps
      if (words.length > 0) {
        let cur = { start: words[0].start, end: words[0].end, text: words[0].text };
        for (let i = 1; i < words.length; i++) {
          const w = words[i];
          if (w.start - cur.end > 0.5) {
            segments.push(cur);
            cur = { start: w.start, end: w.end, text: w.text };
          } else {
            cur.end = w.end;
            cur.text += ' ' + w.text;
          }
        }
        segments.push(cur);
      }

      resolve({ words, segments, fullText: words.map(w => w.text).join(' ') });
    } catch (e) {
      reject(new Error('Failed to parse Premiere transcript: ' + e.message));
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /align — align script lines to transcript words (deterministic)
// Body: { words: [{text,start,end}], scriptLines: ["line1","line2",...] }
// Returns: { ok, alignments: [{start, end, matched, text, status}, ...] }
// ═══════════════════════════════════════════════════════════════════════════
app.post('/align', async (req, res) => {
  try {
    const { words = [], scriptLines = [] } = req.body;
    if (!Array.isArray(words) || !Array.isArray(scriptLines)) {
      throw new Error('words and scriptLines must be arrays');
    }
    const alignments = alignScriptToWords(words, scriptLines);
    res.json({ ok: true, alignments });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Normalize a word for matching: lowercase, strip punctuation
function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/[\.,!\?;:"'\(\)\[\]\{\}—–\-_/\\]/g, '')
    .trim();
}

// Sliding-window alignment: for each script line, find the contiguous window in
// transcript words that best matches (highest LCS score). Bound the search to
// avoid quadratic blowup on long transcripts.
function alignScriptToWords(words, scriptLines) {
  const out = [];
  let cursor = 0;

  for (let li = 0; li < scriptLines.length; li++) {
    const lineRaw = scriptLines[li];
    const lineWords = String(lineRaw || '').split(/\s+/).map(norm).filter(Boolean);
    if (lineWords.length === 0) {
      out.push({ start: null, end: null, matched: 0, text: lineRaw, status: 'empty' });
      continue;
    }

    let bestScore = -1, bestStart = -1, bestEnd = -1;
    const searchEnd = Math.min(words.length, cursor + lineWords.length * 6 + 60);
    for (let i = cursor; i < searchEnd; i++) {
      const minLen = Math.max(1, Math.floor(lineWords.length * 0.5));
      const maxLen = Math.min(words.length - i, Math.ceil(lineWords.length * 2.5));
      for (let len = minLen; len <= maxLen; len++) {
        const window = words.slice(i, i + len).map(w => norm(w.text));
        const score = lcsScore(lineWords, window) - 0.001 * Math.abs(len - lineWords.length);
        if (score > bestScore) {
          bestScore = score;
          bestStart = i;
          bestEnd = i + len - 1;
        }
      }
    }

    if (bestStart < 0 || bestScore < lineWords.length * 0.3) {
      out.push({ start: null, end: null, matched: 0, text: lineRaw, status: 'unmatched' });
    } else {
      out.push({
        start:   words[bestStart].start,
        end:     words[bestEnd].end,
        matched: Math.round(bestScore),
        text:    lineRaw,
        status:  'matched',
      });
      cursor = bestEnd + 1;
    }
  }

  fillGaps(out);
  return out;
}

// Longest common subsequence length — used as similarity score
function lcsScore(a, b) {
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) return 0;
  const dp = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    let prev = 0;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) dp[j] = prev + 1;
      else dp[j] = Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

// Fill in start/end for unmatched lines by interpolating between matched neighbors
function fillGaps(alignments) {
  for (let i = 0; i < alignments.length; i++) {
    if (alignments[i].start != null) continue;
    let prevEnd = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (alignments[j].end != null) { prevEnd = alignments[j].end; break; }
    }
    let nextStart = null, nextDist = 0;
    for (let j = i + 1; j < alignments.length; j++) {
      if (alignments[j].start != null) { nextStart = alignments[j].start; nextDist = j - i; break; }
    }
    if (nextStart != null) {
      const slot = (nextStart - prevEnd) / (nextDist + 1);
      alignments[i].start = prevEnd;
      alignments[i].end   = prevEnd + slot;
    } else {
      alignments[i].start = prevEnd;
      alignments[i].end   = prevEnd + 2;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ELEVENLABS TTS — /tts/voices + /tts/generate
// ═══════════════════════════════════════════════════════════════════════════
const ELEVENLABS_BASE = 'https://api.elevenlabs.io';

function elevenLabsRequest(apiKey, method, urlPath, body, expectBinary) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const url = new URL(ELEVENLABS_BASE + urlPath);
    const headers = {
      'xi-api-key': apiKey,
      'Accept': expectBinary ? 'audio/mpeg' : 'application/json',
    };
    if (body) headers['Content-Type'] = 'application/json';

    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: method,
      headers: headers,
      // ElevenLabs uses valid certs but we don't want SSL surprises
      rejectUnauthorized: true,
    };

    const req = https.request(opts, response => {
      const chunks = [];
      response.on('data', c => chunks.push(c));
      response.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (response.statusCode >= 200 && response.statusCode < 300) {
          if (expectBinary) return resolve({ buffer: buf, contentType: response.headers['content-type'] });
          try { resolve(JSON.parse(buf.toString('utf8'))); }
          catch(e) { reject(new Error('Bad JSON: ' + buf.toString('utf8').slice(0, 200))); }
        } else {
          reject(new Error('ElevenLabs HTTP ' + response.statusCode + ': ' + buf.toString('utf8').slice(0, 300)));
        }
      });
    });
    req.on('error', err => reject(new Error('ElevenLabs network: ' + err.message)));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

app.post('/tts/voices', async (req, res) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey) throw new Error('apiKey required');
    const data = await elevenLabsRequest(apiKey, 'GET', '/v1/voices');
    const voices = (data.voices || []).map(v => ({
      voice_id: v.voice_id,
      name:     v.name,
      labels:   v.labels || {},
      category: v.category,
      preview_url: v.preview_url,
    }));
    res.json({ ok: true, voices });
  } catch (err) {
    console.error('[tts/voices]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// All gens go to ~/Documents/11Lab temp/ as transient files.
// Only moved to user's outputDir when they click Import.
function getTempDir() {
  return path.join(os.homedir(), 'Documents', '11Lab temp');
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    throw new Error('Cannot create folder: ' + dir + ' — ' + e.message);
  }
}

async function generateAndSave(kind, apiKey, urlPath, body, baseFilename, numVariations, applySeed) {
  const tempDir = getTempDir();
  ensureDir(tempDir);
  const results = [];
  for (let v = 1; v <= numVariations; v++) {
    const reqBody = Object.assign({}, body);
    if (applySeed) reqBody.seed = Math.floor(Math.random() * 1e9);

    const result = await elevenLabsRequest(apiKey, 'POST', urlPath, reqBody, true);

    const fname = numVariations === 1
      ? baseFilename + '.mp3'
      : baseFilename + '-v' + v + '.mp3';
    const fpath = path.join(tempDir, fname);
    fs.writeFileSync(fpath, result.buffer);
    console.log('[' + kind + '] v' + v + ' saved', result.buffer.length, 'bytes →', fpath);
    results.push({
      audioPath:  fpath,
      previewUrl: '/tts/audio/' + encodeURIComponent(fname),
      sizeBytes:  result.buffer.length,
      filename:   fname,
    });
  }
  return { variations: results, tempDir };
}

app.post('/tts/generate', async (req, res) => {
  try {
    const {
      apiKey, voiceId, modelId, text, settings,
      filename, variations, outputFormat, languageCode,
    } = req.body;
    if (!apiKey)  throw new Error('apiKey required');
    if (!voiceId) throw new Error('voiceId required');
    if (!text)    throw new Error('text required');

    const baseFilename = (filename && typeof filename === 'string') ? filename.replace(/\.mp3$/i, '') : ('voice-' + Date.now());
    const numVariations = (variations === 2 || variations === '2') ? 2 : 1;
    const isV3 = modelId === 'eleven_v3';

    let urlPath = '/v1/text-to-speech/' + voiceId;
    if (outputFormat) urlPath += '?output_format=' + encodeURIComponent(outputFormat);

    const body = {
      text: text,
      model_id: modelId || 'eleven_multilingual_v2',
    };
    if (!isV3) {
      body.voice_settings = {
        stability:        Number(settings && settings.stability != null  ? settings.stability  : 0.5),
        similarity_boost: Number(settings && settings.similarity != null ? settings.similarity : 0.75),
        style:            Number(settings && settings.style != null      ? settings.style      : 0),
        use_speaker_boost: settings && settings.speakerBoost !== false,
      };
      if (languageCode) body.language_code = languageCode;
    }

    console.log('[tts/generate]', text.length, 'chars, voice:', voiceId, 'model:', body.model_id, 'fmt:', outputFormat || 'default', '| variations:', numVariations);
    const out = await generateAndSave('tts', apiKey, urlPath, body, baseFilename, numVariations, !isV3);
    res.json({ ok: true, variations: out.variations, tempDir: out.tempDir });
  } catch (err) {
    console.error('[tts/generate]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// SFX (sound effects) — /v1/sound-generation
app.post('/sfx/generate', async (req, res) => {
  try {
    const { apiKey, text, durationSec, promptInfluence, filename, variations, outputFormat } = req.body;
    if (!apiKey) throw new Error('apiKey required');
    if (!text)   throw new Error('text (sound description) required');

    const baseFilename = (filename && typeof filename === 'string')
      ? filename.replace(/\.mp3$/i, '')
      : ('sfx-' + Date.now());
    const numVariations = (variations === 2 || variations === '2') ? 2 : 1;

    const body = {
      text: text,
      duration_seconds: Number(durationSec || 3),
      prompt_influence: Number(promptInfluence != null ? promptInfluence : 0.3),
    };

    let sfxUrl = '/v1/sound-generation';
    if (outputFormat) sfxUrl += '?output_format=' + encodeURIComponent(outputFormat);
    console.log('[sfx/generate]', text, '|', body.duration_seconds + 's', 'fmt:', outputFormat || 'default', '| variations:', numVariations);
    const out = await generateAndSave('sfx', apiKey, sfxUrl, body, baseFilename, numVariations, false);
    res.json({ ok: true, variations: out.variations, tempDir: out.tempDir });
  } catch (err) {
    console.error('[sfx/generate]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Music — /v1/music
app.post('/music/generate', async (req, res) => {
  try {
    const { apiKey, prompt, lengthSec, filename, variations } = req.body;
    if (!apiKey) throw new Error('apiKey required');
    if (!prompt) throw new Error('prompt required');

    const baseFilename = (filename && typeof filename === 'string')
      ? filename.replace(/\.mp3$/i, '')
      : ('bgm-' + Date.now());
    const numVariations = (variations === 2 || variations === '2') ? 2 : 1;

    const body = {
      prompt: prompt,
      music_length_ms: Math.round(Number(lengthSec || 10) * 1000),
    };

    console.log('[music/generate]', prompt, '|', lengthSec + 's', '| variations:', numVariations);
    const out = await generateAndSave('music', apiKey, '/v1/music', body, baseFilename, numVariations, false);
    res.json({ ok: true, variations: out.variations, tempDir: out.tempDir });
  } catch (err) {
    console.error('[music/generate]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Proxy ElevenLabs CDN preview_url — fetches once, caches in temp dir, returns local /tts/audio URL
app.post('/tts/voice-preview', async (req, res) => {
  try {
    const { previewUrl, voiceId } = req.body;
    if (!previewUrl) throw new Error('previewUrl required');

    const safeId = (voiceId || 'voice').replace(/[^a-zA-Z0-9_-]/g, '_');
    const cacheFile = path.join(getTempDir(), 'preview-' + safeId + '.mp3');

    if (fs.existsSync(cacheFile)) {
      const fname = path.basename(cacheFile);
      return res.json({ ok: true, previewUrl: '/tts/audio/' + encodeURIComponent(fname) });
    }

    const audioData = await new Promise((resolve, reject) => {
      const https = require('https');
      const http  = require('http');
      const isHttps = previewUrl.startsWith('https');
      const client = isHttps ? https : http;
      client.get(previewUrl, { rejectUnauthorized: false }, (response) => {
        const chunks = [];
        response.on('data', c => chunks.push(c));
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(Buffer.concat(chunks));
          } else {
            reject(new Error('CDN HTTP ' + response.statusCode));
          }
        });
      }).on('error', err => reject(new Error('CDN fetch: ' + err.message)));
    });

    ensureDir(getTempDir());
    fs.writeFileSync(cacheFile, audioData);
    console.log('[voice-preview] cached', cacheFile, audioData.length, 'bytes');
    const fname = path.basename(cacheFile);
    res.json({ ok: true, previewUrl: '/tts/audio/' + encodeURIComponent(fname) });
  } catch (err) {
    console.error('[tts/voice-preview]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Move a file from temp dir to user's chosen output folder (called on Import)
app.post('/tts/move', async (req, res) => {
  try {
    const { sourcePath, targetDir } = req.body;
    if (!sourcePath) throw new Error('sourcePath required');
    if (!targetDir)  throw new Error('targetDir required');
    if (!fs.existsSync(sourcePath)) throw new Error('Source file missing: ' + sourcePath);
    ensureDir(targetDir);
    const filename = path.basename(sourcePath);
    const targetPath = path.join(targetDir, filename);
    fs.copyFileSync(sourcePath, targetPath);
    // Keep temp file for now — user might use the other variation. Cleanup later.
    console.log('[tts/move]', sourcePath, '→', targetPath);
    res.json({ ok: true, targetPath: targetPath });
  } catch (err) {
    console.error('[tts/move]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Serve audio for preview — from temp dir (Documents/11Lab temp/)
app.get('/tts/audio/:filename', (req, res) => {
  const fname = decodeURIComponent(req.params.filename);
  // Allow safe filenames only (no path traversal)
  if (!/^[\w\-. ]+\.mp3$/.test(fname)) return res.status(400).send('Bad filename');
  const fpath = path.join(getTempDir(), fname);
  if (!fs.existsSync(fpath)) {
    // Fallback: old bridge/.tts-output/ (backward compat for files generated before v1.9)
    const legacy = path.join(__dirname, '.tts-output', fname);
    if (fs.existsSync(legacy)) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return fs.createReadStream(legacy).pipe(res);
    }
    return res.status(404).end();
  }
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Access-Control-Allow-Origin', '*');
  fs.createReadStream(fpath).pipe(res);
});

// ── POST /tts/play — play audio file via afplay (macOS) / start (Windows) ──
// Holds the HTTP connection open until playback finishes so the plugin can
// detect natural end via fetch promise resolution.
let currentAfplay = null;

app.post('/tts/play', async (req, res) => {
  const { audioUrl, filePath: fp } = req.body;
  let filePath = fp;
  if (!filePath && audioUrl) {
    // Convert /tts/audio/<filename> → absolute path in temp dir
    const match = audioUrl.match(/^\/tts\/audio\/(.+)$/);
    if (match) filePath = path.join(getTempDir(), decodeURIComponent(match[1]));
  }
  if (!filePath) return res.json({ ok: false, error: 'no file specified' });
  if (!fs.existsSync(filePath)) return res.json({ ok: false, error: 'file not found: ' + path.basename(filePath) });

  // Kill any currently playing audio
  if (currentAfplay) { try { currentAfplay.kill(); } catch(e) {} currentAfplay = null; }

  try {
    await new Promise((resolve, reject) => {
      const proc = process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '/wait', '""', filePath], { shell: true })
        : spawn('afplay', [filePath]);
      currentAfplay = proc;
      proc.on('close', (code) => { if (currentAfplay === proc) currentAfplay = null; resolve(code); });
      proc.on('error', (e) => { if (currentAfplay === proc) currentAfplay = null; reject(e); });
    });
    res.json({ ok: true, finished: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── POST /tts/stop — kill current afplay process ───────────────────────────
app.post('/tts/stop', (req, res) => {
  if (currentAfplay) { try { currentAfplay.kill(); } catch(e) {} currentAfplay = null; }
  res.json({ ok: true });
});

// ── POST /tts/reveal — reveal file in Finder (macOS) / Explorer (Windows) ──
app.post('/tts/reveal', async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.json({ ok: false, error: 'filePath required' });
  try {
    const args = process.platform === 'win32' ? ['/select,', filePath] : ['-R', filePath];
    const cmd  = process.platform === 'win32' ? 'explorer' : 'open';
    await new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { detached: true });
      proc.on('error', reject);
      proc.on('close', resolve);
    });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── POST /api/read-image — bridge reads a local file and returns base64 ───
// Used as a fallback when UXP storage API can't read Finder drag-dropped files
app.post('/api/read-image', async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.json({ ok: false, error: 'filePath required' });
  if (!/\.(png|jpg|jpeg|webp|gif)$/i.test(filePath)) {
    return res.json({ ok: false, error: 'not an image file' });
  }
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    const buf = fs.readFileSync(abs);
    const ext = path.extname(abs).toLowerCase().replace('.', '');
    const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
    const mediaType = mimeMap[ext] || 'image/png';
    res.json({ ok: true, base64: buf.toString('base64'), mediaType, size: buf.length });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── GET /health ────────────────────────────────────────────────────────────
const BRIDGE_VERSION = '1.3.8';
app.get('/health', (_req, res) => {
  res.json({
    status:  'ok',
    version: BRIDGE_VERSION,
    mode:    API_KEY ? 'api-key' : 'cli-oauth',
    model:   DEFAULT_MODEL,
    capabilities: {
      cutlist:     true,    // Recognizes cutlist action format
      multimodal:  true,    // Accepts array content with images
      transcribe:  true,    // /transcribe endpoint
      align:       true,    // /align endpoint
    },
    whisper: {
      bin:   WHISPER_BIN,
      model: WHISPER_MODEL,
      lang:  WHISPER_LANG,
      ok:    fs.existsSync(WHISPER_BIN),
    },
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🎬  Premiere Claude Bridge  →  http://localhost:${PORT}\n`);
});
