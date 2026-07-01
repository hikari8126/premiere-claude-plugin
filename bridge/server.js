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
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'base';
const WHISPER_LANG  = process.env.WHISPER_LANG  || 'en';

// Auto-detect whisper binary: .env override → which → common Python paths
function findWhisperBin() {
  if (process.env.WHISPER_BIN) return process.env.WHISPER_BIN;
  // Try `which whisper` first
  try {
    const { execSync } = require('child_process');
    const p = execSync('which whisper 2>/dev/null', { encoding: 'utf8' }).trim();
    if (p && require('fs').existsSync(p)) return p;
  } catch(e) {}
  const fs = require('fs');
  const versions = ['3.14','3.13','3.12','3.11','3.10','3.9'];
  // Scan Python.framework (installed from python.org)
  for (const v of versions) {
    const p = `/Library/Frameworks/Python.framework/Versions/${v}/bin/whisper`;
    if (fs.existsSync(p)) return p;
  }
  // Scan /Library/Python (system Python / Command Line Tools pip installs here)
  for (const v of versions) {
    const p = `/Library/Python/${v}/bin/whisper`;
    if (fs.existsSync(p)) return p;
  }
  // Homebrew / user local
  for (const p of ['/opt/homebrew/bin/whisper', '/usr/local/bin/whisper',
                   `${process.env.HOME}/.local/bin/whisper`,
                   `${process.env.HOME}/Library/Python/3.9/bin/whisper`]) {
    if (fs.existsSync(p)) return p;
  }
  return ''; // not found — caller must check and show clear error
}
const WHISPER_BIN = findWhisperBin();

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
- autocut_load   {rows: [{script, source, time?|sourceIn?+sourceOut?}]} → organize a cutsheet into the Autocut tab spreadsheet (auto-switch)

── VOICE GEN INTEGRATION ────────────────────────────────────────────────
When the user asks you to:
  • "Generate a voiceover for..." / "Read this script..." / "Create a narration..."
    → emit a voicegen_script action with the script text
    → set autoGenerate: true to start generation immediately
  • "Create a sound effect for..." / "Generate SFX..."
    → emit a voicegen_sfx action
  • You can also specify a voiceId from known ElevenLabs IDs (optional)
  • These actions auto-switch the plugin to the Voice Gen tab

── AUTOCUT TAB INTEGRATION ───────────────────────────────────────────────
When the user gives you a messy/complex script or cutsheet and asks you to
"organize", "clean up", "chuẩn hóa", or "load/đẩy vào Autocut":
  → Reorganize into clean rows and emit an \`autocut_load\` action.
  → Each row: {"script": "<text>", "source": "<bin clip name>", "time": "0:02-0:08"}
     • time may be a string ("0:02-0:08" or "0:05") OR numeric sourceIn/sourceOut (seconds).
  → This fills the Autocut spreadsheet (3 cols: Script | In→Out | Source) and switches
     the plugin to the Autocut tab. The user then reviews and clicks Validate.
  → Apply the SAME merged-cell logic as cutlist below (one script + many sources →
     many rows; one source + many script lines → many rows).

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

    if (!WHISPER_BIN) {
      return reject(new Error(
        'Whisper chưa được cài. Mở Claude Bridge app → menu 🐍 Cài Whisper để cài tự động.'
      ));
    }
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

    // Require ≥50% of script words to be found in transcript window,
    // AND at least 2 words matched (prevents single-word false positives).
    const minScore = Math.max(2, lineWords.length * 0.5);
    if (bestStart < 0 || bestScore < minScore) {
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
// ═══════════════════════════════════════════════════════════════════════════
// ELEVENLABS — shared helpers + TTS + Voice Creation
// ═══════════════════════════════════════════════════════════════════════════
const ELEVENLABS_BASE = 'https://api.elevenlabs.io';
// Shared default key — set in bridge/.env (gitignored, NOT committed to public repo).
// Used only when the plugin request doesn't carry a user key.
const ELEVENLABS_DEFAULT_KEY = process.env.ELEVENLABS_API_KEY || process.env.ELEVENLABS_KEY || '';

// Multipart/form-data POST (for voice cloning — no extra deps needed)
function elevenLabsMultipart(apiKey, urlPath, fields, files) {
  apiKey = apiKey || ELEVENLABS_DEFAULT_KEY;
  return new Promise((resolve, reject) => {
    const boundary = '----ELBoundary' + Date.now().toString(16);
    const parts    = [];

    // Text fields
    for (const [name, value] of Object.entries(fields)) {
      if (value == null) continue;
      parts.push(Buffer.from(
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="' + name + '"\r\n\r\n' +
        String(value) + '\r\n'
      ));
    }
    // File fields
    for (const { fieldName, buffer, filename, contentType } of files) {
      parts.push(Buffer.from(
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="' + fieldName + '"; filename="' + filename + '"\r\n' +
        'Content-Type: ' + (contentType || 'audio/mpeg') + '\r\n\r\n'
      ));
      parts.push(buffer);
      parts.push(Buffer.from('\r\n'));
    }
    parts.push(Buffer.from('--' + boundary + '--\r\n'));

    const body    = Buffer.concat(parts);
    const url     = new URL(ELEVENLABS_BASE + urlPath);
    const opts    = {
      hostname: url.hostname, port: 443,
      path: url.pathname, method: 'POST',
      headers: {
        'xi-api-key':    apiKey,
        'Content-Type':  'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length,
        'Accept':        'application/json',
      },
    };
    const req = require('https').request(opts, response => {
      const chunks = [];
      response.on('data', c => chunks.push(c));
      response.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (response.statusCode >= 200 && response.statusCode < 300) {
          try   { resolve(JSON.parse(buf.toString('utf8'))); }
          catch (e) { reject(new Error('Bad JSON: ' + buf.toString('utf8').slice(0, 200))); }
        } else {
          reject(new Error('ElevenLabs HTTP ' + response.statusCode + ': ' + buf.toString('utf8').slice(0, 300)));
        }
      });
    });
    req.on('error', err => reject(new Error('ElevenLabs network: ' + err.message)));
    req.write(body);
    req.end();
  });
}

// Binary POST — returns { buffer, generationId } (used for voice design preview)
function elevenLabsBinaryPost(apiKey, urlPath, body) {
  apiKey = apiKey || ELEVENLABS_DEFAULT_KEY;
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const url     = new URL(ELEVENLABS_BASE + urlPath);
    const opts    = {
      hostname: url.hostname, port: 443,
      path: url.pathname, method: 'POST',
      headers: {
        'xi-api-key':     apiKey,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Accept':         'audio/mpeg',
      },
    };
    const req = require('https').request(opts, response => {
      const chunks = [];
      const generationId = response.headers['history-item-id'] || null;
      response.on('data', c => chunks.push(c));
      response.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve({ buffer: buf, generationId });
        } else {
          reject(new Error('ElevenLabs HTTP ' + response.statusCode + ': ' + buf.toString('utf8').slice(0, 300)));
        }
      });
    });
    req.on('error', err => reject(new Error('ElevenLabs network: ' + err.message)));
    req.write(bodyStr);
    req.end();
  });
}

function elevenLabsRequest(apiKey, method, urlPath, body, expectBinary) {
  apiKey = apiKey || ELEVENLABS_DEFAULT_KEY;
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

async function generateAndSave(kind, apiKey, urlPath, body, baseFilename, numVariations, applySeed, outputDir) {
  // Save to outputDir when provided; otherwise fall back to temp dir.
  const saveDir = (outputDir && typeof outputDir === 'string' && outputDir.trim())
    ? outputDir.trim()
    : getTempDir();
  ensureDir(saveDir);
  const results = [];
  for (let v = 1; v <= numVariations; v++) {
    const reqBody = Object.assign({}, body);
    if (applySeed) reqBody.seed = Math.floor(Math.random() * 1e9);

    const result = await elevenLabsRequest(apiKey, 'POST', urlPath, reqBody, true);

    const fname = numVariations === 1
      ? baseFilename + '.mp3'
      : baseFilename + '-v' + v + '.mp3';
    const fpath = path.join(saveDir, fname);
    fs.writeFileSync(fpath, result.buffer);
    console.log('[' + kind + '] v' + v + ' saved', result.buffer.length, 'bytes →', fpath);
    results.push({
      audioPath:  fpath,
      previewUrl: '/tts/audio/' + encodeURIComponent(fname),
      sizeBytes:  result.buffer.length,
      filename:   fname,
    });
  }
  return { variations: results, saveDir };
}

app.post('/tts/generate', async (req, res) => {
  try {
    const {
      apiKey, voiceId, modelId, text, settings,
      filename, variations, outputFormat, languageCode, outputDir,
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

    console.log('[tts/generate]', text.length, 'chars, voice:', voiceId, 'model:', body.model_id, 'fmt:', outputFormat || 'default', '| variations:', numVariations, outputDir ? '→ ' + outputDir : '→ temp');
    const out = await generateAndSave('tts', apiKey, urlPath, body, baseFilename, numVariations, !isV3, outputDir);
    res.json({ ok: true, variations: out.variations, saveDir: out.saveDir });
  } catch (err) {
    console.error('[tts/generate]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// SFX (sound effects) — /v1/sound-generation
app.post('/sfx/generate', async (req, res) => {
  try {
    const { apiKey, text, durationSec, promptInfluence, filename, variations, outputFormat, outputDir } = req.body;
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
    console.log('[sfx/generate]', text, '|', body.duration_seconds + 's', 'fmt:', outputFormat || 'default', '| variations:', numVariations, outputDir ? '→ ' + outputDir : '→ temp');
    const out = await generateAndSave('sfx', apiKey, sfxUrl, body, baseFilename, numVariations, false, outputDir);
    res.json({ ok: true, variations: out.variations, saveDir: out.saveDir });
  } catch (err) {
    console.error('[sfx/generate]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Music — /v1/music
app.post('/music/generate', async (req, res) => {
  try {
    const { apiKey, prompt, lengthSec, filename, variations, outputDir } = req.body;
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

    console.log('[music/generate]', prompt, '|', lengthSec + 's', '| variations:', numVariations, outputDir ? '→ ' + outputDir : '→ temp');
    const out = await generateAndSave('music', apiKey, '/v1/music', body, baseFilename, numVariations, false, outputDir);
    res.json({ ok: true, variations: out.variations, saveDir: out.saveDir });
  } catch (err) {
    console.error('[music/generate]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /voice/clone ─────────────────────────────────────────────────────
app.post('/voice/clone', async (req, res) => {
  try {
    const { apiKey, voiceName, filePath, description, removeNoise } = req.body;
    if (!apiKey)    throw new Error('apiKey required');
    if (!voiceName) throw new Error('voiceName required');
    if (!filePath)  throw new Error('filePath required');
    if (!fs.existsSync(filePath)) throw new Error('Audio file not found: ' + filePath);

    const fields = { name: voiceName };
    if (description) fields.description = description;
    if (removeNoise) fields.remove_background_noise = 'true';

    const audioBuffer   = fs.readFileSync(filePath);
    const audioFilename = path.basename(filePath);
    const files = [{
      fieldName:   'files',
      buffer:      audioBuffer,
      filename:    audioFilename,
      contentType: 'audio/mpeg',
    }];

    console.log('[voice/clone] name:', voiceName, 'file:', filePath, fs.statSync(filePath).size + 'B');
    const data = await elevenLabsMultipart(apiKey, '/v1/voices/add', fields, files);
    res.json({ ok: true, voice_id: data.voice_id, name: voiceName });
  } catch (err) {
    console.error('[voice/clone]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /voice/design/preview ────────────────────────────────────────────
app.post('/voice/design/preview', async (req, res) => {
  try {
    const { apiKey, gender, age, accent, accentStrength, text } = req.body;
    if (!apiKey) throw new Error('apiKey required');
    if (!text)   throw new Error('text required');

    const body = {
      gender:          gender  || 'female',
      age:             age     || 'young',
      accent:          accent  || 'american',
      accent_strength: Number(accentStrength || 1.0),
      text:            text,
    };

    console.log('[voice/design/preview]', JSON.stringify(body));
    const result = await elevenLabsBinaryPost(apiKey, '/v1/voice-generation/generate-voice', body);

    const tempDir = getTempDir();
    ensureDir(tempDir);
    const fname = 'vd-preview-' + Date.now() + '.mp3';
    const fpath = path.join(tempDir, fname);
    fs.writeFileSync(fpath, result.buffer);

    res.json({
      ok:           true,
      generationId: result.generationId,
      previewUrl:   '/tts/audio/' + encodeURIComponent(fname),
    });
  } catch (err) {
    console.error('[voice/design/preview]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /voice/design/save ───────────────────────────────────────────────
app.post('/voice/design/save', async (req, res) => {
  try {
    const { apiKey, voiceName, description, generatedVoiceId } = req.body;
    if (!apiKey)           throw new Error('apiKey required');
    if (!voiceName)        throw new Error('voiceName required');
    if (!generatedVoiceId) throw new Error('generatedVoiceId required');

    const body = {
      voice_name:         voiceName,
      voice_description:  description || '',
      generated_voice_id: generatedVoiceId,
    };

    console.log('[voice/design/save] name:', voiceName, 'genId:', generatedVoiceId);
    const data = await elevenLabsRequest(apiKey, 'POST', '/v1/voice-generation/create-voice', body);
    res.json({ ok: true, voice_id: data.voice_id, name: voiceName });
  } catch (err) {
    console.error('[voice/design/save]', err.message);
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
    const { sourcePath, targetDir, targetName } = req.body;
    if (!sourcePath) throw new Error('sourcePath required');
    if (!targetDir)  throw new Error('targetDir required');
    if (!fs.existsSync(sourcePath)) throw new Error('Source file missing: ' + sourcePath);
    ensureDir(targetDir);
    const filename = targetName || path.basename(sourcePath); // allow custom filename
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
  const { audioUrl, filePath: fp, startOffset } = req.body;
  let filePath = fp;
  if (!filePath && audioUrl) {
    const match = audioUrl.match(/^\/tts\/audio\/(.+)$/);
    if (match) filePath = path.join(getTempDir(), decodeURIComponent(match[1]));
  }
  if (!filePath) return res.json({ ok: false, error: 'no file specified' });
  if (!fs.existsSync(filePath)) return res.json({ ok: false, error: 'file not found: ' + path.basename(filePath) });

  if (currentAfplay) { try { currentAfplay.kill(); } catch(e) {} currentAfplay = null; }

  const offset = parseFloat(startOffset) || 0;

  try {
    await new Promise((resolve, reject) => {
      let proc;
      if (process.platform === 'win32') {
        proc = spawn('cmd', ['/c', 'start', '/wait', '""', filePath], { shell: true });
      } else if (offset > 0) {
        proc = spawn('ffplay', ['-nodisp', '-autoexit', '-ss', String(offset), filePath], { stdio: 'pipe' });
      } else {
        proc = spawn('afplay', [filePath]);
      }
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

// ── POST /tts/duration — get audio file duration via ffprobe ──────────────
app.post('/tts/duration', async (req, res) => {
  const { audioPath } = req.body;
  if (!audioPath) return res.json({ ok: false, error: 'audioPath required' });
  if (!fs.existsSync(audioPath)) return res.json({ ok: false, error: 'file not found' });
  try {
    const dur = await new Promise((resolve, reject) => {
      const proc = spawn('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', audioPath,
      ], { stdio: 'pipe' });
      let out = '';
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.on('close', code => code === 0 ? resolve(parseFloat(out.trim())) : reject(new Error('ffprobe exit ' + code)));
      proc.on('error', reject);
    });
    res.json({ ok: true, duration: dur });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
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

// ── Version comparison helper ──────────────────────────────────────────────
function isNewer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0, vb = pb[i] || 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return false;
}

// ── POST /plugin/check-update — compare plugin version against Gist ────────
const UPDATE_MANIFEST_URL = 'https://gist.githubusercontent.com/hikari8126/8fb346e839dedd559dfc60317b1456cf/raw/version.json';

app.post('/plugin/check-update', async (req, res) => {
  const { currentVersion } = req.body;
  try {
    // AbortController guards against Gist hanging forever (Node fetch has no default timeout).
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    let data;
    try {
      const r = await fetch(UPDATE_MANIFEST_URL + '?t=' + Date.now(), { signal: ctrl.signal });
      data = await r.json();
    } finally { clearTimeout(t); }
    const latestVersion  = data.pluginVersion    || '';
    const downloadUrl    = data.pluginDownloadUrl || '';
    const hasUpdate = latestVersion && downloadUrl && isNewer(latestVersion, currentVersion);
    res.json({ ok: true, hasUpdate: !!hasUpdate, latestVersion, downloadUrl });
  } catch(e) {
    res.json({ ok: false, error: e.name === 'AbortError' ? 'timeout fetching manifest' : e.message });
  }
});

// Streaming download with redirect-following + idle timeout.
// Node's fetch().arrayBuffer() buffers the whole body with no timeout, so a stalled
// connection hangs forever — the cause of "đứng ở bước download update". This pipes
// straight to disk and aborts if no data arrives for `idleMs`.
function downloadFile(url, destPath, { idleMs = 30000, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const tmpPath = destPath + '.tmp';
    const file = fs.createWriteStream(tmpPath);
    let settled = false;
    function fail(err) {
      if (settled) return;
      settled = true;
      try { file.destroy(); } catch {}
      try { fs.unlinkSync(tmpPath); } catch {}
      reject(err);
    }
    function get(targetUrl, redirectsLeft) {
      const lib = targetUrl.startsWith('http://') ? require('http') : require('https');
      const request = lib.get(targetUrl, { rejectUnauthorized: false }, response => {
        const sc = response.statusCode;
        if ([301, 302, 303, 307, 308].includes(sc) && response.headers.location) {
          response.resume(); // drain
          if (redirectsLeft <= 0) return fail(new Error('too many redirects'));
          const next = new URL(response.headers.location, targetUrl).toString();
          return get(next, redirectsLeft - 1);
        }
        if (sc !== 200) {
          response.resume();
          return fail(new Error(`Download failed: HTTP ${sc}`));
        }
        const total = parseInt(response.headers['content-length'] || '0', 10);
        let downloaded = 0;
        response.on('data', chunk => {
          downloaded += chunk.length;
          request.setTimeout(idleMs); // reset idle timer on every chunk
        });
        response.pipe(file);
        file.on('finish', () => {
          if (settled) return;
          file.close(() => {
            try { fs.renameSync(tmpPath, destPath); } catch (e) { return fail(e); }
            settled = true;
            console.log(`[plugin/update] downloaded ${destPath} (${downloaded}/${total || '?'}B)`);
            resolve(destPath);
          });
        });
      });
      request.setTimeout(idleMs, () => {
        request.destroy(new Error(`download stalled (no data for ${idleMs/1000}s)`));
      });
      request.on('error', err => fail(err));
    }
    get(url, maxRedirects);
  });
}

// ── POST /plugin/update — download CCX and open with Creative Cloud ─────────
app.post('/plugin/update', async (req, res) => {
  const { downloadUrl, version } = req.body;
  if (!downloadUrl) return res.status(400).json({ ok: false, error: 'downloadUrl required' });
  try {
    const tmpDir = getTempDir();
    ensureDir(tmpDir);
    const ccxPath = path.join(tmpDir, `claude-ai-assistant-v${version || 'latest'}.ccx`);

    await downloadFile(downloadUrl, ccxPath);

    // Open with Creative Cloud (macOS: open triggers CC installer)
    await new Promise((resolve, reject) => {
      const proc = spawn('open', [ccxPath], { detached: true });
      proc.on('close', resolve);
      proc.on('error', reject);
    });
    res.json({ ok: true });
  } catch(e) {
    console.error('[plugin/update]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /tts/concat-from-sequence ─────────────────────────────────────────
// Receives [{filePath, inPoint, outPoint}] clips from plugin (A1 track items).
// Uses ffmpeg to extract each audio segment and concatenate into a single MP3.
app.post('/tts/concat-from-sequence', async (req, res) => {
  const { clips, outputDir } = req.body;
  if (!clips || !Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ ok: false, error: 'No clips provided' });
  }

  // Check ffmpeg is available
  try {
    await new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', ['-version'], { stdio: 'pipe' });
      p.on('close', code => (code === 0 ? resolve() : reject(new Error('ffmpeg not found'))));
      p.on('error', () => reject(new Error('ffmpeg not installed — run: brew install ffmpeg')));
    });
  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message });
  }

  const tmpDir = getTempDir();
  ensureDir(tmpDir);
  const ts = Date.now();
  const segPaths = [];

  try {
    // Extract each clip segment to a temp WAV
    for (let i = 0; i < clips.length; i++) {
      const { filePath, inPoint, outPoint } = clips[i];
      if (!filePath) throw new Error(`Clip ${i + 1}: missing filePath`);
      if (!fs.existsSync(filePath)) throw new Error(`Clip ${i + 1}: file not found: ${filePath}`);

      const segPath = path.join(tmpDir, `concat_seg_${ts}_${i}.wav`);
      await new Promise((resolve, reject) => {
        const args = [
          '-y', '-i', filePath,
          '-ss', String(inPoint || 0),
          '-to', String(outPoint || 0),
          '-vn', '-acodec', 'pcm_s16le',
          segPath,
        ];
        const proc = spawn('ffmpeg', args, { stdio: 'pipe' });
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('close', code => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg segment ${i + 1} failed: ${stderr.slice(-300)}`));
        });
        proc.on('error', e => reject(new Error('ffmpeg error: ' + e.message)));
      });
      segPaths.push(segPath);
    }

    // Write concat list file
    const listPath = path.join(tmpDir, `concat_list_${ts}.txt`);
    fs.writeFileSync(listPath, segPaths.map(p => `file '${p}'`).join('\n'));

    // Concatenate segments → MP3
    const saveDir = (outputDir && typeof outputDir === 'string' && outputDir.trim())
      ? outputDir.trim() : tmpDir;
    ensureDir(saveDir);
    const outPath = path.join(saveDir, `sequence_audio_${ts}.mp3`);

    await new Promise((resolve, reject) => {
      const args = [
        '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
        '-acodec', 'libmp3lame', '-q:a', '2',
        outPath,
      ];
      const proc = spawn('ffmpeg', args, { stdio: 'pipe' });
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error('ffmpeg concat failed: ' + stderr.slice(-300)));
      });
      proc.on('error', e => reject(new Error('ffmpeg error: ' + e.message)));
    });

    // Cleanup temp segments and list
    for (const seg of segPaths) { try { fs.unlinkSync(seg); } catch(e) {} }
    try { fs.unlinkSync(listPath); } catch(e) {}

    console.log('[concat-from-sequence]', clips.length, 'clips →', outPath);
    res.json({ ok: true, audioPath: outPath });

  } catch(e) {
    for (const seg of segPaths) { try { fs.unlinkSync(seg); } catch(err) {} }
    console.error('[concat-from-sequence]', e.message);
    res.status(500).json({ ok: false, error: e.message });
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

// ══════════════════════════════════════════════════════════════════════════════
// SUPER AUTO CUT endpoints
// ══════════════════════════════════════════════════════════════════════════════

// ── POST /superautocut/validate — validate block structure ─────────────────
app.post('/superautocut/validate', (req, res) => {
  const { blocks } = req.body || {};
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return res.json({ ok: false, error: 'No blocks provided' });
  }

  const errors = [];
  blocks.forEach((block, i) => {
    const label = `Block ${i + 1}`;
    if (!Array.isArray(block.texts) || block.texts.length === 0) {
      errors.push(`${label}: không có text`);
    }
    if (!Array.isArray(block.sources) || block.sources.length === 0) {
      errors.push(`${label}: không có source`);
    } else {
      block.sources.forEach((s, j) => {
        if (!s.name || !s.name.trim()) errors.push(`${label} source ${j + 1}: thiếu tên`);
        // timestamp có thể rỗng → full clip (không cần báo lỗi)
      });
    }
  });

  if (errors.length > 0) return res.json({ ok: false, errors });
  res.json({ ok: true, blockCount: blocks.length });
});

// ── POST /superautocut/voice-align ──────────────────────────────────────────
// Transcribe a single voice file (whole cutsheet) then align each block's text
// to find where that block's voice segment starts/ends.
// Body: { audioPath, blocks: [{texts: [...]}], language? }
// Returns: { ok, alignments: [{start, end, duration, matched, status}], fullText }
app.post('/superautocut/voice-align', async (req, res) => {
  try {
    const { audioPath, blocks = [], language } = req.body || {};
    if (!audioPath) throw new Error('audioPath is required');
    if (!Array.isArray(blocks) || blocks.length === 0) throw new Error('blocks is required');

    // 1) Whisper → word timestamps
    const { words, fullText } = await transcribeWhisper(audioPath, language);

    // 2) One script line per block (join all of the block's text lines)
    const scriptLines = blocks.map(b =>
      (Array.isArray(b.texts) ? b.texts.join(' ') : String(b.texts || '')).trim()
    );

    // 3) Align → per-block start/end, then derive duration
    console.log('[voice-align] scriptLines:', JSON.stringify(scriptLines));
    console.log('[voice-align] transcript:', (fullText || '').slice(0, 300));
    const aligned = alignScriptToWords(words, scriptLines);
    console.log('[voice-align] results:', aligned.map(a => a.status + '(' + a.matched + ')').join(' | '));
    const alignments = aligned.map(a => ({
      start:   a.start,
      end:     a.end,
      duration: (a.start != null && a.end != null) ? Math.max(0, a.end - a.start) : null,
      matched: a.matched,
      status:  a.status,
    }));

    res.json({ ok: true, alignments, fullText });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /superautocut/subtext — word-synced .srt from voice + script ───────
// Whisper word-level timestamps on the voice file, then map the USER'S SCRIPT
// text onto those timings (script = source of truth for spelling/diacritics;
// whisper only supplies WHEN each word is spoken). Chunk into short social cues.
// Body: { audioPath, scriptLines:[...], language?, outputPath?, maxWords?, maxChars?, maxDur? }
// Returns: { ok, path, cues:[{index,start,end,text}], srt }

// Flatten script lines → word tokens, keeping raw text + normalized form + line index.
function subtextFlattenScript(scriptLines) {
  const out = [];
  scriptLines.forEach((line, li) => {
    String(line || '').trim().split(/\s+/).filter(Boolean).forEach(raw => {
      out.push({ raw, n: norm(raw), line: li, start: null, end: null });
    });
  });
  return out;
}

// Assign a start/end to each script word by matching it forward against whisper
// words (tolerant of whisper mis-hears / extra script words via a lookahead),
// then interpolating timing for any words that didn't match.
function subtextAssignTimes(sw, whisper) {
  const wnorm = whisper.map(w => norm(w.text));
  let wi = 0;
  const LOOK = 10;
  for (const s of sw) {
    let found = -1;
    const stop = Math.min(whisper.length, wi + LOOK);
    for (let j = wi; j < stop; j++) {
      if (wnorm[j] && wnorm[j] === s.n) { found = j; break; }
    }
    if (found >= 0) { s.start = whisper[found].start; s.end = whisper[found].end; wi = found + 1; }
  }
  subtextInterpolate(sw, whisper);
}

// First whisper speech onset (start of a word preceded by a >0.4s silence)
// within (after, before). Used to keep interpolated words out of silent gaps.
function subtextFirstOnset(whisper, after, before) {
  for (let k = 1; k < whisper.length; k++) {
    const prevEnd = whisper[k - 1].end, st = whisper[k].start;
    if (st > before) break;
    if (prevEnd >= after - 0.05 && (st - prevEnd) > 0.4) return st;
  }
  return null;
}

function subtextInterpolate(sw, whisper) {
  const n = sw.length;
  const audioEnd = whisper.length ? whisper[whisper.length - 1].end : n;
  const firstKnown = sw.findIndex(s => s.start != null);
  if (firstKnown < 0) { // nothing matched → spread evenly across the audio
    for (let i = 0; i < n; i++) { sw[i].start = audioEnd * i / n; sw[i].end = audioEnd * (i + 1) / n; }
    return;
  }
  for (let i = 0; i < firstKnown; i++) { sw[i].start = 0; sw[i].end = sw[firstKnown].start; }
  let i = firstKnown;
  while (i < n) {
    if (sw[i].start != null) { i++; continue; }
    let j = i; while (j < n && sw[j].start == null) j++;
    let   leftEnd    = sw[i - 1].end;
    const rightStart = (j < n) ? sw[j].start : audioEnd;
    // Unmatched words after a pause are the onset of a new utterance (whisper
    // often mis-hears the first word). Don't spread them from the previous
    // word's end — that drops the caption into the silent gap, making it show
    // "voice + the PRECEDING gap". Snap the run to where speech actually resumes.
    const onset = subtextFirstOnset(whisper, leftEnd, rightStart);
    if (onset != null && onset > leftEnd) leftEnd = onset;
    const span = Math.max(0, rightStart - leftEnd), cnt = j - i;
    for (let k = 0; k < cnt; k++) {
      sw[i + k].start = leftEnd + span * k / cnt;
      sw[i + k].end   = leftEnd + span * (k + 1) / cnt;
    }
    i = j;
  }
}

// Function words that must lead a phrase, never dangle at the END of a cue.
// (articles, coordinating/subordinating conjunctions, relatives, common prepositions)
const SUBTEXT_FN_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'so', 'yet', 'for',
  'that', 'which', 'who', 'whom', 'whose', 'when', 'while', 'where', 'why', 'how',
  'because', 'since', 'although', 'though', 'if', 'unless', 'until', 'as', 'than',
  'at', 'in', 'on', 'of', 'to', 'with', 'by', 'from', 'into', 'onto', 'about',
  'over', 'under', 'after', 'before', 'between', 'through',
  // determiners / quantifiers / possessives — lead a phrase, never dangle
  'no', 'not', 'this', 'these', 'those', 'every', 'each', 'all', 'both',
  'some', 'any', 'such', 'more', 'most', 'my', 'your', 'his', 'her', 'its', 'our', 'their',
]);
function subtextIsFn(w) { return SUBTEXT_FN_WORDS.has(norm(w.raw)); }

// Group timed words into short caption cues with PHRASE-AWARE breaks:
//  • break AFTER clause/sentence punctuation (, ; : . ! ? …)
//  • break on line change or when word/char/dur caps are exceeded
//  • never end a cue on a function word — carry it forward so it leads the next
//    phrase (fixes dangling "...and" / "...for a" / "...that").
function subtextChunk(sw, opts) {
  const maxWords = opts.maxWords || 7;
  const maxChars = opts.maxChars || 42;
  const maxDur   = opts.maxDur   || 3.0;
  const cues = [];
  let cur = null;
  const textOf = (c) => c.words.map(w => w.raw).join(' ');
  const seed = (s) => { cur = { words: [s], line: s.line, start: s.start, end: s.end }; };
  // Close the current cue; move any trailing function words to a fresh cue so
  // they lead the next phrase instead of dangling. `hard` = ended at clause/
  // sentence punctuation → a real phrase boundary that merges must NOT cross.
  const flush = (hard) => {
    if (!cur || !cur.words.length) { cur = null; return; }
    const carry = [];
    while (cur.words.length > 1 && subtextIsFn(cur.words[cur.words.length - 1])) {
      carry.unshift(cur.words.pop());
    }
    cur.end = cur.words[cur.words.length - 1].end;
    cur.hard = !!hard;
    cues.push(cur);
    cur = null;
    carry.forEach(s => { if (!cur) seed(s); else { cur.words.push(s); cur.end = s.end; } });
  };
  for (const s of sw) {
    if (cur) {
      const merged = textOf(cur) + ' ' + s.raw;
      const dur    = (s.end != null ? s.end : cur.end) - cur.start;
      if (s.line !== cur.line || cur.words.length >= maxWords || merged.length > maxChars || dur > maxDur) flush(false);
    }
    if (!cur) seed(s); else { cur.words.push(s); cur.end = s.end; }
    if (/[.!?…,;:]$/.test(s.raw)) flush(true);   // break after clause/sentence punctuation
  }
  flush(false);

  // Re-absorb single-word cues left by overflow. Merge toward the SOFT boundary
  // (an overflow split) and never across a HARD boundary (punctuation): e.g.
  // "Designed by a 20-year" | "expert" → merge back; "expert," | "trusted" |
  // "by over 50,000 women" → "trusted" merges forward (prev ended on a comma).
  const SLACK = 12;
  for (let k = 0; k < cues.length; k++) {
    const c = cues[k];
    if (c.words.length !== 1) continue;
    const prev = cues[k - 1], next = cues[k + 1];
    const beforeHard = prev ? prev.hard : true;       // stream start = hard
    const afterHard  = c.hard && next ? true : (next ? c.hard : true); // stream end = hard
    const fitBack = prev && prev.line === c.line &&
      (textOf(prev) + ' ' + textOf(c)).length <= maxChars + SLACK;
    const fitFwd  = next && next.line === c.line &&
      (textOf(c) + ' ' + textOf(next)).length <= maxChars + SLACK;
    let dir = null;
    if (!beforeHard && fitBack && (afterHard || !fitFwd)) dir = 'back';
    else if (!afterHard && fitFwd && (beforeHard || !fitBack)) dir = 'fwd';
    else if (!beforeHard && fitBack) dir = 'back';     // both soft → prefer back
    else if (!afterHard && fitFwd) dir = 'fwd';
    if (dir === 'back') {
      prev.words = prev.words.concat(c.words); prev.end = c.end; prev.hard = c.hard;
      cues.splice(k, 1); k--;
    } else if (dir === 'fwd') {
      next.words = c.words.concat(next.words); next.start = c.start;
      cues.splice(k, 1); k--;
    }
  }

  return subtextFinalize(cues);
}

function subtextTextOf(c) { return c.words.map(w => w.raw).join(' '); }

// Back-to-back timing + index + trailing-comma cleanup. Shared by the rule
// chunker and the AI segmenter so both emit identical cue shapes.
function subtextFinalize(cues) {
  for (let k = 0; k < cues.length; k++) {
    if (k + 1 < cues.length) cues[k].end = cues[k + 1].start;
    if (cues[k].end <= cues[k].start) cues[k].end = cues[k].start + 0.4;
  }
  return cues.map((c, i) => ({ index: i + 1, start: c.start, end: c.end, text: subtextTextOf(c).replace(/[,;:]+$/, '') }));
}

// AI segmentation: ask the LLM to insert line breaks into the (already-timed)
// word stream WITHOUT changing any word, then regroup sw by those breaks so
// timing stays exact. Returns finalized cues, or null on any failure → caller
// falls back to the rule chunker.
async function subtextSegmentAI(sw, opts, llm) {
  if (!sw || sw.length < 2) return null;
  const maxChars = opts.maxChars || 42;
  // Reconstruct the source lines (each is a distinct on-screen segment) so the
  // model never merges separate script lines into one caption.
  const srcLines = [];
  let ln = -1;
  for (const w of sw) { if (w.line !== ln) { srcLines.push([]); ln = w.line; } srcLines[srcLines.length - 1].push(w.raw); }
  const text = srcLines.map(a => a.join(' ')).join('\n');
  const prompt = [
    'You split a voice-over transcript into SUBTITLE LINES for on-screen captions.',
    'Return ONLY the lines, one per row — no numbering, no quotes, no commentary.',
    'STRICT RULES:',
    '1. Output the EXACT same words in the EXACT same order. Do NOT add, remove, reorder, reword, or fix spelling/grammar. ONLY decide where each line breaks.',
    '2. The transcript already has line breaks separating DISTINCT on-screen segments. NEVER merge across them — keep each input line separate; you may only SPLIT a line further if it is long.',
    '3. Break at natural phrase boundaries: after commas/clauses, before conjunctions and relative pronouns.',
    '4. NEVER end a line with a function word (a, an, the, and, or, that, which, of, to, for, at, in, on, with, by, no, both, your…) — let it lead the next line.',
    '5. Keep phrasal verbs ("gave up") and modifier+noun ("extra pull") together on one line.',
    `6. Aim for about ${maxChars} characters per line max, but prioritise natural phrasing over strict length.`,
    'TRANSCRIPT:',
    text,
  ].join('\n');

  let out;
  try {
    out = await callLLM(prompt, { provider: llm.provider, model: llm.model, apiKey: llm.apiKey, maxTokens: 2048 });
  } catch (e) { console.warn('[subtext AI] LLM error:', e.message); return null; }

  const lines = (out || '').split('\n').map(s => s.replace(/^\s*[-*•\d.)\]]+\s*/, '').trim()).filter(Boolean);
  if (lines.length < 1) return null;

  // Flatten AI tokens (with line index) and align to sw by position, tolerant of
  // minor diffs. Bail (→ fallback) if alignment drifts too much.
  const aiTok = [];
  lines.forEach((ln, li) => ln.split(/\s+/).filter(Boolean).forEach(tok => aiTok.push({ n: norm(tok), li })));
  let j = 0, miss = 0;
  for (let i = 0; i < sw.length; i++) {
    const sn = norm(sw[i].raw);
    if (j < aiTok.length && aiTok[j].n === sn) { sw[i]._seg = aiTok[j].li; j++; continue; }
    // resync: look ahead a few AI tokens for a match
    let found = -1;
    for (let k = j; k < Math.min(aiTok.length, j + 4); k++) { if (aiTok[k].n === sn) { found = k; break; } }
    if (found >= 0) { sw[i]._seg = aiTok[found].li; j = found + 1; }
    else { sw[i]._seg = (i > 0 ? sw[i - 1]._seg : 0); miss++; }
  }
  if (miss > Math.max(3, sw.length * 0.12)) { console.warn(`[subtext AI] align drift miss=${miss}/${sw.length} → fallback`); return null; }

  // Group sw by AI line index → raw cues. ALSO force a break on original script
  // line change so the AI can never glue two distinct segments together.
  const cues = [];
  let cur = null;
  for (const w of sw) {
    if (!cur || w._seg !== cur._seg || w.line !== cur.line) { cur = { words: [], _seg: w._seg, line: w.line, start: w.start, end: w.end }; cues.push(cur); }
    cur.words.push(w); cur.end = w.end;
  }
  cues.forEach(c => { c.start = c.words[0].start; c.end = c.words[c.words.length - 1].end; });
  // Clean up stray single-word cues by merging them into a SAME-LINE neighbour
  // (guards against the model leaving a word orphaned, e.g. "50,000+").
  const SLACK = 12;
  for (let k = 0; k < cues.length; k++) {
    const c = cues[k];
    if (c.words.length !== 1) continue;
    const prev = cues[k - 1], next = cues[k + 1];
    const fitBack = prev && prev.line === c.line && (subtextTextOf(prev) + ' ' + subtextTextOf(c)).length <= maxChars + SLACK;
    const fitFwd  = next && next.line === c.line && (subtextTextOf(c) + ' ' + subtextTextOf(next)).length <= maxChars + SLACK;
    if (fitBack && !fitFwd) { prev.words = prev.words.concat(c.words); prev.end = c.end; cues.splice(k, 1); k--; }
    else if (fitFwd) { next.words = c.words.concat(next.words); next.start = c.start; cues.splice(k, 1); k--; }
  }
  return cues.length ? subtextFinalize(cues) : null;
}

function subtextSecToSrt(sec) {
  if (sec < 0) sec = 0;
  const ms = Math.round((sec % 1) * 1000), total = Math.floor(sec);
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)},${pad(ms, 3)}`;
}

function subtextToSrt(cues) {
  return cues.map(c => `${c.index}\n${subtextSecToSrt(c.start)} --> ${subtextSecToSrt(c.end)}\n${c.text}\n`).join('\n');
}

// Concat timeline clips (chronological) into one mp3 via ffmpeg → returns path.
// Build a TIMELINE-ACCURATE audio: each clip placed at its timeline position with
// silence filling the gaps, so Whisper timestamps map straight onto the timeline.
// Audio t=0 ↔ timeline `offset` (= first clip's start); caller adds `offset` to cues.
// Returns { audioPath, offset }. Uniform 16kHz mono so the concat demuxer accepts all parts.
async function subtextConcatClips(clips) {
  const tmpDir = getTempDir(); ensureDir(tmpDir);
  const ts = Date.now();
  const parts = [];     // ordered segment paths (clips + silence)
  const tmpFiles = [];
  const AR = '16000';
  const order = clips.slice().sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0));
  const offset = Math.max(0, Number(order[0] && order[0].start) || 0);

  function run(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', args, { stdio: 'pipe' });
      let err = ''; proc.stderr.on('data', d => { err += d.toString(); });
      proc.on('close', c => c === 0 ? resolve() : reject(new Error('ffmpeg: ' + err.slice(-220))));
      proc.on('error', e => reject(new Error('ffmpeg: ' + e.message)));
    });
  }

  try {
    let cursor = offset; // timeline time covered so far (audio begins at the first clip)
    let totalGap = 0;
    for (let i = 0; i < order.length; i++) {
      const c = order[i];
      if (!c.filePath) throw new Error(`Clip ${i + 1}: thiếu filePath`);
      if (!fs.existsSync(c.filePath)) throw new Error(`Clip ${i + 1}: không thấy file ${c.filePath}`);
      const start = Math.max(0, Number(c.start) || 0);
      const inS   = Math.max(0, Number(c.inPoint) || 0);
      let   outS  = Math.max(0, Number(c.outPoint) || 0);
      if (outS <= inS) outS = inS + 0.05;

      // Gap before this clip (timeline) → insert exact silence so timing stays aligned.
      const gap = start - cursor;
      if (gap > 0.02) {
        totalGap += gap;
        const silPath = path.join(tmpDir, `sub_sil_${ts}_${i}.wav`);
        await run(['-y', '-f', 'lavfi', '-i', `anullsrc=r=${AR}:cl=mono`,
          '-t', gap.toFixed(3), '-acodec', 'pcm_s16le', silPath]);
        parts.push(silPath); tmpFiles.push(silPath);
      }
      // Clip segment, forced to uniform format.
      const segPath = path.join(tmpDir, `sub_seg_${ts}_${i}.wav`);
      await run(['-y', '-i', c.filePath, '-ss', inS.toFixed(3), '-to', outS.toFixed(3),
        '-vn', '-ar', AR, '-ac', '1', '-acodec', 'pcm_s16le', segPath]);
      parts.push(segPath); tmpFiles.push(segPath);
      cursor = start + (outS - inS);
    }
    const listPath = path.join(tmpDir, `sub_list_${ts}.txt`); tmpFiles.push(listPath);
    fs.writeFileSync(listPath, parts.map(p => `file '${p}'`).join('\n'));
    const outPath = path.join(tmpDir, `sub_audio_${ts}.mp3`);
    await run(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-acodec', 'libmp3lame', '-q:a', '2', outPath]);
    const realDur = await ffprobeDuration(outPath);
    for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch (e) {} }
    console.log(`[subtext] timeline-accurate audio: ${order.length} clips, offset ${offset.toFixed(2)}s, total gap-silence ${totalGap.toFixed(2)}s, audio dur ${realDur.toFixed(2)}s (timeline span ${(cursor - offset).toFixed(2)}s)`);
    return { audioPath: outPath, offset: offset };
  } catch (e) {
    for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch (er) {} }
    throw e;
  }
}

// No-script path: use whisper's own words; tag each with its segment index so the
// chunker breaks at natural whisper phrase boundaries (e.g. "No mark" | "No digging in").
function subtextWordsFromWhisper(words, segments) {
  segments = segments || [];
  let si = 0;
  return words.map(w => {
    while (si < segments.length - 1 && w.start >= segments[si].end) si++;
    return { raw: w.text, n: norm(w.text), line: si, start: w.start, end: w.end };
  });
}

// Audio duration in seconds via ffprobe (resolves 0 on any failure).
function ffprobeDuration(audioPath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', audioPath], { stdio: 'pipe' });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('close', () => resolve(parseFloat(out.trim()) || 0));
    proc.on('error', () => resolve(0));
  });
}

app.post('/superautocut/subtext', async (req, res) => {
  try {
    let { audioPath, clips, scriptLines = [], language, outputPath, maxWords, maxChars, maxDur,
          useAI, provider, model, apiKey } = req.body || {};
    // Source audio: a direct path OR a list of timeline clips → timeline-accurate render.
    let offset = 0;
    if (Array.isArray(clips) && clips.length) {
      console.log(`[subtext] timeline-accurate concat of ${clips.length} clips...`);
      const r = await subtextConcatClips(clips);
      audioPath = r.audioPath; offset = r.offset;
    }
    if (!audioPath) throw new Error('Cần audioPath hoặc clips');
    if (!fs.existsSync(audioPath)) throw new Error('audio not found: ' + audioPath);

    const { words, segments } = await transcribeWhisper(audioPath, language);
    if (!words || !words.length) throw new Error('Whisper không nhận được từ nào');

    const cleanScript = (Array.isArray(scriptLines) ? scriptLines : []).filter(s => String(s || '').trim());
    let sw;
    if (cleanScript.length) {
      // Script provided → use the user's text, borrow timing from whisper.
      sw = subtextFlattenScript(cleanScript);
      subtextAssignTimes(sw, words);
    } else {
      // No script → whisper text + segment-boundary cue breaks.
      sw = subtextWordsFromWhisper(words, segments);
    }
    if (!sw.length) throw new Error('Không có nội dung để tạo phụ đề');
    // AI phrase-segmentation (verbatim) if requested; fall back to the rule chunker.
    let cues = null;
    if (useAI) {
      cues = await subtextSegmentAI(sw, { maxChars }, { provider, model, apiKey });
      console.log(cues ? `[subtext] AI segmentation → ${cues.length} cues` : '[subtext] AI segmentation failed → rule chunker');
    }
    if (!cues) cues = subtextChunk(sw, { maxWords, maxChars, maxDur });
    // Extend the LAST cue to the true audio end — whisper's last word usually ends
    // before the audio actually does, leaving total subtitle span < voice length.
    if (cues.length) {
      const audioDur = await ffprobeDuration(audioPath);
      const last = cues[cues.length - 1];
      if (audioDur > last.end) last.end = audioDur;
    }
    // Shift cue times to absolute timeline (audio t=0 ↔ timeline `offset`) → drag .srt at 0 = aligned.
    if (offset) cues.forEach(c => { c.start += offset; c.end += offset; });
    const srt  = subtextToSrt(cues);
    console.log(`[subtext] ${words.length} words · ${cleanScript.length ? 'script' : 'whisper'} → ${cues.length} cues · offset ${offset.toFixed(2)}s`);

    let savedPath;
    if (outputPath) {
      ensureDir(path.dirname(outputPath));
      fs.writeFileSync(outputPath, srt, 'utf8');
      savedPath = outputPath;
    } else {
      savedPath = path.join(getTempDir(), 'subtext_' + Date.now() + '.srt');
      ensureDir(path.dirname(savedPath));
      fs.writeFileSync(savedPath, srt, 'utf8');
    }
    res.json({ ok: true, path: savedPath, cues, srt });
  } catch (e) {
    console.error('[subtext]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /superautocut/parse-image — Claude Vision parses cutsheet screenshot
app.post('/superautocut/parse-image', async (req, res) => {
  const { imageBase64 } = req.body || {};
  if (!imageBase64) return res.json({ ok: false, error: 'No image provided' });

  // Extract mime + base64 data
  const match = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return res.json({ ok: false, error: 'Invalid image format' });
  const [, mimeType, b64data] = match;

  const prompt = `You are given a screenshot of a video editing cutsheet table.
The table has up to 3 columns:
  1. Script/Text — voiceover script (may be empty if this row belongs to a merged cell above)
  2. Time — timestamp range like "0:02-0:08" or single "0:04" (may be empty)
  3. Source — source clip name like "Yoselin 33" (may be empty)

Rules:
- Merged cells: if a cell visually spans multiple rows, put the value only in the FIRST row; use empty string "" for subsequent rows
- Multi-line text inside one cell: treat as one string, separate lines with \\n
- Empty cells: use empty string ""

Return ONLY a JSON array, no markdown, no explanation:
[{"text":"...","time":"...","source":"..."},...]`;

  // Save image to temp file (needed for CLI mode)
  const ext     = mimeType.includes('png') ? 'png' : 'jpg';
  const tmpImg  = path.join(os.tmpdir(), 'sac_parse_' + Date.now() + '.' + ext);
  fs.writeFileSync(tmpImg, Buffer.from(b64data, 'base64'));

  try {
    let outputText = '';

    if (API_KEY) {
      // ── API key mode: Anthropic SDK ──────────────────────────────────────
      const Anthropic = require('@anthropic-ai/sdk');
      const client    = new Anthropic({ apiKey: API_KEY });
      const response  = await client.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 2048,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: b64data } },
          { type: 'text', text: prompt },
        ]}],
      });
      outputText = response.content[0]?.text || '';
    } else {
      // ── CLI mode: pass image via @path token ─────────────────────────────
      const cliPrompt = `@${tmpImg}\n\n${prompt}`;
      outputText = await new Promise((resolve, reject) => {
        let out = '', err = '';
        const proc = spawn('claude', ['--print', cliPrompt], { env: cleanEnv() });
        proc.stdout.on('data', d => { out += d.toString(); });
        proc.stderr.on('data', d => { err += d.toString(); });
        proc.on('close', code => code === 0 ? resolve(out) : reject(new Error(err || 'claude CLI exit ' + code)));
        proc.on('error', reject);
      });
    }

    const jsonMatch = outputText.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) throw new Error('Không tìm thấy JSON array trong phản hồi của Claude');
    const rows = JSON.parse(jsonMatch[0]);
    fs.unlinkSync(tmpImg);
    res.json({ ok: true, rows });
  } catch (e) {
    try { fs.unlinkSync(tmpImg); } catch (_) {}
    res.json({ ok: false, error: e.message });
  }
});

// Shared LLM call: provider 'gemini' → Google Gemini REST; else Anthropic SDK (request
// key → bridge API_KEY) → claude CLI fallback. Returns the model's text output.
async function callLLM(prompt, opts) {
  opts = opts || {};
  var provider = opts.provider, model = opts.model, apiKey = opts.apiKey;
  var maxTokens = opts.maxTokens || 2048;
  if (provider === 'gemini') {
    const gKey = apiKey || process.env.GEMINI_API_KEY || '';
    if (!gKey) throw new Error('Chưa có Gemini API key (Settings hoặc GEMINI_API_KEY trong bridge .env)');
    const gModel = model || 'gemini-3.5-flash';
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
                encodeURIComponent(gModel) + ':generateContent?key=' + encodeURIComponent(gKey);
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      // thinkingBudget:0 → no "thinking" tokens, so the whole output budget is text
      // (Flash 3.x have thinking on by default, which can otherwise return empty text).
      generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } },
    };
    // Gemini Flash 3.x occasionally returns 503 (high demand) — retry a few times.
    let dj, r;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      dj = await r.json();
      if (r.ok) break;
      if (r.status === 503 && attempt < 2) { await new Promise(function(res){ setTimeout(res, 1500); }); continue; }
      throw new Error('Gemini: ' + ((dj && dj.error && dj.error.message) || ('HTTP ' + r.status)));
    }
    const cand = dj && dj.candidates && dj.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    return parts.map(function(p) { return p.text || ''; }).join('').trim();
  }
  const anthKey = apiKey || API_KEY;
  if (anthKey) {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: anthKey });
    const resp = await client.messages.create({ model: model || DEFAULT_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
    return resp.content[0].text.trim();
  }
  const { spawnSync } = require('child_process');
  const claudeEnv = cleanEnv();
  claudeEnv.PATH = ((claudeEnv.HOME || process.env.HOME || '') + '/.npm-global/bin') + ':' + claudeEnv.PATH;
  const result = spawnSync('claude', ['--print'], { input: prompt, encoding: 'utf8', timeout: 90000, env: claudeEnv });
  if (result.error) throw result.error;
  return (result.stdout || '').trim();
}

// ── POST /superautocut/parse-cutsheet ───────────────────────────────────────
// AI parse a messy pasted cutsheet (TSV from Google Sheets) → normalized rows.
app.post('/superautocut/parse-cutsheet', async (req, res) => {
  const { text, provider, model, apiKey } = req.body;
  if (!text || !String(text).trim()) return res.status(400).json({ ok: false, error: 'No text' });
  const prompt =
`Bạn là trợ lý phân tích "cutsheet" (bảng dựng video) dán từ Google Sheets — định dạng lộn xộn do người làm tay.
Cột thường có: LỜI THOẠI (voice/script), TIMECODE (in→out), SOURCE (tên clip/footage). Thứ tự cột có thể khác; có ô gộp nên vài ô trống.

Chuyển thành MẢNG JSON, mỗi phần tử = một SOURCE cần cắt:
{ "text": "<lời thoại của block, '' nếu không có>", "time": "<timecode in-out>", "source": "<tên source/clip>" }

Quy tắc:
- Mỗi source = 1 phần tử. Nếu một ô chứa nhiều source/timecode (ngăn bởi xuống dòng, "/", "&", "và") → tách thành nhiều phần tử, ghép timecode↔source theo đúng thứ tự.
- time: bỏ tiền tố "Giây/giây/s"; giữ dạng "in-out" (vd "0-3", "1:09-1:10"); bỏ ghi chú "(speed up)", "tua nhanh", "(kéo cọ...)". Nếu timecode nằm CHUNG trong ô source (vd "Borrow trượt nước 0-3", "K6 + K15 (2s đầu)") thì tách ra, để lại tên source.
- text: lấy từ cột thoại; không có thì "". Các dòng thoại liên tiếp của cùng 1 cảnh có thể gộp.
- KHÔNG bịa; giữ nguyên tên source (kể cả .mp4, mã như K10/K14opt4, số như 22).
- CHỈ trả JSON mảng, KHÔNG markdown, KHÔNG giải thích.

Cutsheet:
<<<
${text}
>>>`;
  try {
    const out = await callLLM(prompt, { provider, model, apiKey, maxTokens: 4096 });
    var jsonStr = out;
    var m = out.match(/\[[\s\S]*\]/); // strip any prose/markdown around the array
    if (m) jsonStr = m[0];
    var rows;
    try { rows = JSON.parse(jsonStr); }
    catch (e) { return res.json({ ok: false, error: 'AI trả về không phải JSON hợp lệ', raw: out.slice(0, 600) }); }
    if (!Array.isArray(rows)) return res.json({ ok: false, error: 'AI không trả mảng JSON' });
    rows = rows.map(function (r) {
      return { text: String((r && r.text) || ''), time: String((r && r.time) || ''), source: String((r && r.source) || '') };
    }).filter(function (r) { return r.text || r.time || r.source; });
    res.json({ ok: true, rows: rows });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Tách output normalize thành 1 dòng / mỗi thẻ [emotion] — KHÔNG phụ thuộc model
// có xuống dòng hay không. Bỏ ```fence, ép line-break TRƯỚC mọi thẻ [..], gom khoảng
// trắng, bỏ số thứ tự lỡ thêm, drop dòng trống.
function splitByEmotionTags(output) {
  let s = String(output || '')
    .replace(/```[a-z]*/gi, '')   // bỏ mọi marker code-fence
    .trim();
  // Chèn newline trước mỗi thẻ [..] (thẻ = [nội dung ngắn, không chứa ] hay xuống dòng]).
  s = s.replace(/\s*(\[[^\]\n]{1,40}\])\s*/g, '\n$1 ');
  return s.split('\n')
    .map(l => l.replace(/^\d+[\.\)]\s*/, '').trim())
    .filter(Boolean);
}

// ── Unified "Organize" prompt ───────────────────────────────────────────────
// ONE prompt shared by both entry points (Voice Gen "Organize" + Autocut "Gen
// voice") so the SAME input always yields the SAME organized script. Both flows
// join the output lines with \n and feed ElevenLabs; Autocut voice-align maps
// block↔audio via block.texts separately, so a differing output line count here
// never breaks alignment.
function buildOrganizePrompt(rawText) {
  return `# Context:
- I will give you the raw voice-over content for my product video. It is not yet organized/optimized for generating an ElevenLabs v3 voiceover. Reorganize it following the requirements below. The final output is used to generate the ElevenLabs voiceover.

# Requirements:
+ IMPORTANT 1: Do NOT change or alter the original content. Do NOT correct grammar and do NOT add a missing subject — subjectless sentences are an intentional stylistic choice, not a mistake.
+ IMPORTANT 2: Do NOT add new content/words/linking phrases. If a word or subject is not in the original, do NOT add it.
+ Keep the ORIGINAL LANGUAGE of the script (Vietnamese stays Vietnamese, English stays English). Do not translate the content itself.
+ If the original has fragmented phrases of one complete sentence split by line breaks, identify and connect them when you can.
+ A sentence must always end with a punctuation mark (use "!" when it needs emotional emphasis).
+ Write the important / emphasis words in FULL UPPERCASE — ALL CAPS, every letter of the word (e.g. "one goal" => "ONE GOAL", "never" => "NEVER"). Not just the first letter. ElevenLabs will stress fully-uppercased words.
+ Remove any icons or emoji.
+ Only fix CLEAR spelling typos. Never rephrase, never change word choice or meaning.
+ Expand acronyms / symbols / numbers into plain spoken words. Examples: OMG => Oh my god, 2X softer => 2 times softer, 65% off => 65 percent off, 1000+ washes => more than 1000 washes, oz => ounce, 2026 => twenty twenty six, 2M+ => more than 2 millions, DESIGNED FOR 50+ => designed for 50 plus, 9° => 9 degrees, Our #1 summer pants => Our number one summer pants.
+ Add an emotion tag in [] at the FRONT of EVERY sentence to guide the ElevenLabs voice. Example: [Excited] We create this pants with ONE GOAL.
+ Suggested tags (pick the best fit per sentence; not limited to this list): [excited] [energetic] [warm] [friendly] [confident] [dramatic] [urgent] [whispering] [conversational] [serious] [calm] [reflective] [empathetic] [curious] [laughing]

# Output format (IMPORTANT):
- Put EACH sentence on its OWN line, starting with its [emotion] tag.
- There MUST be a line break BEFORE every [emotion] tag — never put two [emotion] tags on the same line, never run sentences together in one paragraph.
- Example:
[Reflective] Decades of bras that never quite fit.
[Empathetic] You weren't the problem.
[Confident] SonaShape was built around a different belief.
- Return ONLY the final organized script. No preamble, no explanation, no markdown code fences, no numbering.

# Raw voice over contents:
${rawText}`;
}

// ── POST /superautocut/normalize-script ────────────────────────────────────
// Chuẩn hóa script qua Claude: sửa dấu câu, chính tả — KHÔNG đổi nội dung.
// Input:  { lines: string[] }   — mảng string, 1 phần tử / block
// Output: { ok, lines: string[] }
app.post('/superautocut/normalize-script', async (req, res) => {
  const { lines, provider, model, apiKey, mode } = req.body;
  if (!Array.isArray(lines) || lines.length === 0)
    return res.status(400).json({ ok: false, error: 'No lines provided' });

  // UNIFIED: both entry points (Voice Gen "Organize" — mode:'paragraph' — and
  // Autocut "Gen voice" — no mode) now use the SAME prompt, so identical input
  // gives an identical organized script. The `mode` param is accepted for
  // backward-compat but no longer changes the transformation. Output line count
  // is NOT forced to match block count (Autocut voice-align uses block.texts).
  const rawText = lines.join('\n');
  const prompt = buildOrganizePrompt(rawText);

  try {
    const output = await callLLM(prompt, { provider, model, apiKey, maxTokens: 4096 });
    // Post-process: ép mỗi thẻ [emotion] ra 1 dòng riêng (không phụ thuộc model).
    const outLines = splitByEmotionTags(output);
    if (!outLines.length) {
      console.warn('[normalize] Empty output — fallback to originals');
      return res.json({ ok: true, lines, warning: 'empty_output' });
    }
    return res.json({ ok: true, lines: outLines });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── GET /health ────────────────────────────────────────────────────────────
const BRIDGE_VERSION = '1.7.4';  // normalize-script: hop nhat 2 prompt Organize (Voice Gen + Autocut) dung chung buildOrganizePrompt() -> 2 ket qua tuong dong; CAPS = ALL CAPS toan bo chu
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

// ── POST /superautocut/split-voice ────────────────────────────────────────
// Split a voice file into N segments using ffmpeg (one per block).
// Fixes UXP bug: createSetInOutPointsAction changes master clip globally,
// affecting all placed track items. Giving each block its own file avoids this.
// Input:  { audioPath, segments: [{start, end}] }
// Output: { ok, files: [path0, path1, ...] }
app.post('/superautocut/split-voice', async (req, res) => {
  const { audioPath, segments } = req.body;
  if (!audioPath || !fs.existsSync(audioPath))
    return res.status(400).json({ ok: false, error: 'audioPath not found: ' + audioPath });
  if (!Array.isArray(segments) || segments.length === 0)
    return res.status(400).json({ ok: false, error: 'No segments provided' });

  const tmpDir = getTempDir();
  ensureDir(tmpDir);
  const ts  = Date.now();
  const ext = path.extname(audioPath) || '.mp3';

  const files = [];
  try {
    for (let i = 0; i < segments.length; i++) {
      const { start, end } = segments[i];
      const outPath = path.join(tmpDir, `sac_voice_b${i}_${ts}${ext}`);
      await new Promise((resolve, reject) => {
        const args = [
          '-y', '-i', audioPath,
          '-ss', String(start),
          '-to', String(end),
          '-vn',                         // drop video if any
          '-acodec', 'copy',             // stream copy (fast, no re-encode)
          '-avoid_negative_ts', 'make_zero',
          outPath,
        ];
        const proc = spawn('ffmpeg', args, { stdio: 'pipe' });
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('close', code => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg block ${i} failed: ` + stderr.slice(-200)));
        });
        proc.on('error', e => reject(new Error('ffmpeg: ' + e.message)));
      });
      files.push(outPath);
    }
    res.json({ ok: true, files });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🎬  Premiere Claude Bridge  →  http://localhost:${PORT}\n`);
});
