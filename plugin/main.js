/* =========================================================
   Claude AI — Premiere Pro UXP Plugin  v1.3.1
   Single non-module script (no import/export).
   API confirmed from Adobe DVA internal plugins (text/copilot).
   Key pattern: trackGroup + ClipTrack.queryCast + getTrackItems(1,false)
   ========================================================= */

// ── Premiere API wrapper (async) ───────────────────────────────────────────

var ppro = null;
try { ppro = require('premierepro'); } catch(e) { console.warn('premierepro not available:', e.message); }

// ── Global flat icon system (FontAwesome solid SVG paths) ───────────────────
// UXP can't load icon fonts and ignores fill:currentColor → colour is baked into
// each <path fill>. Put <i data-ic="NAME"> in HTML (optionally data-ic-size /
// data-ic-color); pluginRenderIcons() fills them. For JS use pluginIconSVG().
var PI_ICONS = {
    arrow_right: { vb: '0 0 448 512', d: 'M438.6 278.6c12.5-12.5 12.5-32.8 0-45.3l-160-160c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L338.8 224 32 224c-17.7 0-32 14.3-32 32s14.3 32 32 32l306.7 0L233.4 393.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0l160-160z', c: '#cbd5e1' },
    audio: { vb: '0 0 512 512', d: 'M499.1 6.3c8.1 6 12.9 15.6 12.9 25.7v72V368c0 44.2-43 80-96 80s-96-35.8-96-80s43-80 96-80c11.2 0 22 1.6 32 4.6V147L192 223.8V432c0 44.2-43 80-96 80s-96-35.8-96-80s43-80 96-80c11.2 0 22 1.6 32 4.6V200 128c0-14.1 9.3-26.6 22.8-30.7l320-96c9.7-2.9 20.2-1.1 28.3 5z', c: '#a855f7' },
    bolt: { vb: '0 0 448 512', d: 'M349.4 44.6c5.9-13.7 1.5-29.7-10.6-38.5s-28.6-8-39.9 1.8l-256 224c-10 8.8-13.6 22.9-8.9 35.3S50.7 288 64 288l111.5 0L98.6 467.4c-5.9 13.7-1.5 29.7 10.6 38.5s28.6 8 39.9-1.8l256-224c10-8.8 13.6-22.9 8.9-35.3s-16.6-20.7-30-20.7l-111.5 0L349.4 44.6z', c: '#c084fc' },
    check: { vb: '0 0 448 512', d: 'M438.6 105.4c12.5 12.5 12.5 32.8 0 45.3l-256 256c-12.5 12.5-32.8 12.5-45.3 0l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L160 338.7 393.4 105.4c12.5-12.5 32.8-12.5 45.3 0z', c: '#22c55e' },
    chevron_down: { vb: '0 0 512 512', d: 'M233.4 406.6c12.5 12.5 32.8 12.5 45.3 0l192-192c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L256 338.7 86.6 169.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l192 192z', c: '#cbd5e1' },
    circle_info: { vb: '0 0 512 512', d: 'M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM216 336l24 0 0-64-24 0c-13.3 0-24-10.7-24-24s10.7-24 24-24l48 0c13.3 0 24 10.7 24 24l0 88 8 0c13.3 0 24 10.7 24 24s-10.7 24-24 24l-80 0c-13.3 0-24-10.7-24-24s10.7-24 24-24zm40-208a32 32 0 1 1 0 64 32 32 0 1 1 0-64z', c: '#cbd5e1' },
    closed_captioning: { vb: '0 0 576 512', d: 'M0 96C0 60.7 28.7 32 64 32l448 0c35.3 0 64 28.7 64 64l0 320c0 35.3-28.7 64-64 64L64 480c-35.3 0-64-28.7-64-64L0 96zM200 208c14.2 0 27 6.1 35.8 16c8.8 9.9 24 10.7 33.9 1.9s10.7-24 1.9-33.9c-17.5-19.6-43.1-32-71.5-32c-53 0-96 43-96 96s43 96 96 96c28.4 0 54-12.4 71.5-32c8.8-9.9 8-25-1.9-33.9s-25-8-33.9 1.9c-8.8 9.9-21.6 16-35.8 16c-26.5 0-48-21.5-48-48s21.5-48 48-48zm144 48c0-26.5 21.5-48 48-48c14.2 0 27 6.1 35.8 16c8.8 9.9 24 10.7 33.9 1.9s10.7-24 1.9-33.9c-17.5-19.6-43.1-32-71.5-32c-53 0-96 43-96 96s43 96 96 96c28.4 0 54-12.4 71.5-32c8.8-9.9 8-25-1.9-33.9s-25-8-33.9 1.9c-8.8 9.9-21.6 16-35.8 16c-26.5 0-48-21.5-48-48z', c: '#cbd5e1' },
    download: { vb: '0 0 512 512', d: 'M288 32c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 242.7-73.4-73.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l128 128c12.5 12.5 32.8 12.5 45.3 0l128-128c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L288 274.7 288 32zM64 352c-35.3 0-64 28.7-64 64l0 32c0 35.3 28.7 64 64 64l384 0c35.3 0 64-28.7 64-64l0-32c0-35.3-28.7-64-64-64l-101.5 0-45.3 45.3c-25 25-65.5 25-90.5 0L165.5 352 64 352zm368 56a24 24 0 1 1 0 48 24 24 0 1 1 0-48z', c: '#cbd5e1' },
    file: { vb: '0 0 384 512', d: 'M0 64C0 28.7 28.7 0 64 0H224V128c0 17.7 14.3 32 32 32H384V448c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V64zm384 64H256V0L384 128z', c: 'rgba(255,255,255,.55)' },
    floppy_disk: { vb: '0 0 448 512', d: 'M64 32C28.7 32 0 60.7 0 96L0 416c0 35.3 28.7 64 64 64l320 0c35.3 0 64-28.7 64-64l0-242.7c0-17-6.7-33.3-18.7-45.3L352 50.7C340 38.7 323.7 32 306.7 32L64 32zm0 96c0-17.7 14.3-32 32-32l192 0c17.7 0 32 14.3 32 32l0 64c0 17.7-14.3 32-32 32L96 224c-17.7 0-32-14.3-32-32l0-64zM224 288a64 64 0 1 1 0 128 64 64 0 1 1 0-128z', c: '#cbd5e1' },
    folder: { vb: '0 0 512 512', d: 'M64 480H448c35.3 0 64-28.7 64-64V160c0-35.3-28.7-64-64-64H298.5c-17 0-33.3-6.7-45.3-18.7L226.7 50.7c-12-12-28.3-18.7-45.3-18.7H64C28.7 32 0 60.7 0 96V416c0 35.3 28.7 64 64 64z', c: '#eab308' },
    folder_open: { vb: '0 0 576 512', d: 'M88.7 223.8L0 375.8 0 96C0 60.7 28.7 32 64 32l117.5 0c17 0 33.3 6.7 45.3 18.7l26.5 26.5c12 12 28.3 18.7 45.3 18.7L416 96c35.3 0 64 28.7 64 64l0 32-336 0c-22.8 0-43.8 12.1-55.3 31.8zm27.6 16.1C122.1 230 132.6 224 144 224l400 0c11.5 0 22 6.1 27.7 16.1s5.7 22.2-.1 32.1l-112 192C453.9 474 443.4 480 432 480L32 480c-11.5 0-22-6.1-27.7-16.1s-5.7-22.2 .1-32.1l112-192z', c: '#cbd5e1' },
    gauge_high: { vb: '0 0 512 512', d: 'M0 256a256 256 0 1 1 512 0A256 256 0 1 1 0 256zM288 96a32 32 0 1 0 -64 0 32 32 0 1 0 64 0zM256 416c35.3 0 64-28.7 64-64c0-17.4-6.9-33.1-18.1-44.6L366 161.7c5.3-12.1-.2-26.3-12.3-31.6s-26.3 .2-31.6 12.3L257.9 288c-.6 0-1.3 0-1.9 0c-35.3 0-64 28.7-64 64s28.7 64 64 64zM176 144a32 32 0 1 0 -64 0 32 32 0 1 0 64 0zM96 288a32 32 0 1 0 0-64 32 32 0 1 0 0 64zm352-32a32 32 0 1 0 -64 0 32 32 0 1 0 64 0z', c: '#cbd5e1' },
    gear: { vb: '0 0 512 512', d: 'M495.9 166.6c3.2 8.7 .5 18.4-6.4 24.6l-43.3 39.4c1.1 8.3 1.7 16.8 1.7 25.4s-.6 17.1-1.7 25.4l43.3 39.4c6.9 6.2 9.6 15.9 6.4 24.6c-4.4 11.9-9.7 23.3-15.8 34.3l-4.7 8.1c-6.6 11-14 21.4-22.1 31.2c-5.9 7.2-15.7 9.6-24.5 6.8l-55.7-17.7c-13.4 10.3-28.2 18.9-44 25.4l-12.5 57.1c-2 9.1-9 16.3-18.2 17.8c-13.8 2.3-28 3.5-42.5 3.5s-28.7-1.2-42.5-3.5c-9.2-1.5-16.2-8.7-18.2-17.8l-12.5-57.1c-15.8-6.5-30.6-15.1-44-25.4L83.1 425.9c-8.8 2.8-18.6 .3-24.5-6.8c-8.1-9.8-15.5-20.2-22.1-31.2l-4.7-8.1c-6.1-11-11.4-22.4-15.8-34.3c-3.2-8.7-.5-18.4 6.4-24.6l43.3-39.4C64.6 273.1 64 264.6 64 256s.6-17.1 1.7-25.4L22.4 191.2c-6.9-6.2-9.6-15.9-6.4-24.6c4.4-11.9 9.7-23.3 15.8-34.3l4.7-8.1c6.6-11 14-21.4 22.1-31.2c5.9-7.2 15.7-9.6 24.5-6.8l55.7 17.7c13.4-10.3 28.2-18.9 44-25.4l12.5-57.1c2-9.1 9-16.3 18.2-17.8C227.3 1.2 241.5 0 256 0s28.7 1.2 42.5 3.5c9.2 1.5 16.2 8.7 18.2 17.8l12.5 57.1c15.8 6.5 30.6 15.1 44 25.4l55.7-17.7c8.8-2.8 18.6-.3 24.5 6.8c8.1 9.8 15.5 20.2 22.1 31.2l4.7 8.1c6.1 11 11.4 22.4 15.8 34.3zM256 336a80 80 0 1 0 0-160 80 80 0 1 0 0 160z', c: '#cbd5e1' },
    image: { vb: '0 0 512 512', d: 'M0 96C0 60.7 28.7 32 64 32H448c35.3 0 64 28.7 64 64V416c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V96zM323.8 202.5c-4.5-6.6-11.9-10.5-19.8-10.5s-15.4 3.9-19.8 10.5l-87 127.6L170.7 297c-4.6-5.7-11.5-9-18.7-9s-14.2 3.3-18.7 9l-64 80c-5.8 7.2-6.9 17.1-2.9 25.4s12.4 13.6 21.6 13.6h96 32H424c8.9 0 17.1-4.9 21.2-12.8s3.6-17.4-1.4-24.7l-120-176zM112 192a48 48 0 1 0 0-96 48 48 0 1 0 0 96z', c: '#f59e0b' },
    layer_group: { vb: '0 0 576 512', d: 'M264.5 5.2c14.9-6.9 32.1-6.9 47 0l218.6 101c8.5 3.9 13.9 12.4 13.9 21.8s-5.4 17.9-13.9 21.8l-218.6 101c-14.9 6.9-32.1 6.9-47 0L45.9 149.8C37.4 145.8 32 137.3 32 128s5.4-17.9 13.9-21.8L264.5 5.2zM476.9 209.6l53.2 24.6c8.5 3.9 13.9 12.4 13.9 21.8s-5.4 17.9-13.9 21.8l-218.6 101c-14.9 6.9-32.1 6.9-47 0L45.9 277.8C37.4 273.8 32 265.3 32 256s5.4-17.9 13.9-21.8l53.2-24.6 152 70.2c23.4 10.8 50.4 10.8 73.8 0l152-70.2zm0 144l53.2 24.6c8.5 3.9 13.9 12.4 13.9 21.8s-5.4 17.9-13.9 21.8l-218.6 101c-14.9 6.9-32.1 6.9-47 0L45.9 405.8C37.4 401.8 32 393.3 32 384s5.4-17.9 13.9-21.8l53.2-24.6 152 70.2c23.4 10.8 50.4 10.8 73.8 0l152-70.2z', c: '#ec4899' },
    microphone: { vb: '0 0 384 512', d: 'M192 0C139 0 96 43 96 96l0 160c0 53 43 96 96 96s96-43 96-96l0-160c0-53-43-96-96-96zM64 216c0-13.3-10.7-24-24-24s-24 10.7-24 24l0 40c0 89.1 66.2 162.7 152 174.4l0 33.6-48 0c-13.3 0-24 10.7-24 24s10.7 24 24 24l72 0 72 0c13.3 0 24-10.7 24-24s-10.7-24-24-24l-48 0 0-33.6c85.8-11.7 152-85.3 152-174.4l0-40c0-13.3-10.7-24-24-24s-24 10.7-24 24l0 40c0 70.7-57.3 128-128 128s-128-57.3-128-128l0-40z', c: '#cbd5e1' },
    microphone_lines: { vb: '0 0 384 512', d: 'M96 96l0 160c0 53 43 96 96 96s96-43 96-96l-80 0c-8.8 0-16-7.2-16-16s7.2-16 16-16l80 0 0-32-80 0c-8.8 0-16-7.2-16-16s7.2-16 16-16l80 0 0-32-80 0c-8.8 0-16-7.2-16-16s7.2-16 16-16l80 0c0-53-43-96-96-96S96 43 96 96zM320 240l0 16c0 70.7-57.3 128-128 128s-128-57.3-128-128l0-40c0-13.3-10.7-24-24-24s-24 10.7-24 24l0 40c0 89.1 66.2 162.7 152 174.4l0 33.6-48 0c-13.3 0-24 10.7-24 24s10.7 24 24 24l72 0 72 0c13.3 0 24-10.7 24-24s-10.7-24-24-24l-48 0 0-33.6c85.8-11.7 152-85.3 152-174.4l0-40c0-13.3-10.7-24-24-24s-24 10.7-24 24l0 24z', c: '#cbd5e1' },
    palette: { vb: '0 0 512 512', d: 'M512 256c0 .9 0 1.8 0 2.7c-.4 36.5-33.6 61.3-70.1 61.3L344 320c-26.5 0-48 21.5-48 48c0 3.4 .4 6.7 1 9.9c2.1 10.2 6.5 20 10.8 29.9c6.1 13.8 12.1 27.5 12.1 42c0 31.8-21.6 60.7-53.4 62c-3.5 .1-7 .2-10.6 .2C114.6 512 0 397.4 0 256S114.6 0 256 0S512 114.6 512 256zM128 288a32 32 0 1 0 -64 0 32 32 0 1 0 64 0zm0-96a32 32 0 1 0 0-64 32 32 0 1 0 0 64zM288 96a32 32 0 1 0 -64 0 32 32 0 1 0 64 0zm96 96a32 32 0 1 0 0-64 32 32 0 1 0 0 64z', c: '#cbd5e1' },
    paperclip: { vb: '0 0 448 512', d: 'M364.2 83.8c-24.4-24.4-64-24.4-88.4 0l-184 184c-42.1 42.1-42.1 110.3 0 152.4s110.3 42.1 152.4 0l152-152c10.9-10.9 28.7-10.9 39.6 0s10.9 28.7 0 39.6l-152 152c-64 64-167.6 64-231.6 0s-64-167.6 0-231.6l184-184c46.3-46.3 121.3-46.3 167.6 0s46.3 121.3 0 167.6l-176 176c-28.6 28.6-75 28.6-103.6 0s-28.6-75 0-103.6l144-144c10.9-10.9 28.7-10.9 39.6 0s10.9 28.7 0 39.6l-144 144c-6.7 6.7-6.7 17.7 0 24.4s17.7 6.7 24.4 0l176-176c24.4-24.4 24.4-64 0-88.4z', c: '#cbd5e1' },
    pause: { vb: '0 0 320 512', d: 'M48 64C21.5 64 0 85.5 0 112L0 400c0 26.5 21.5 48 48 48l32 0c26.5 0 48-21.5 48-48l0-288c0-26.5-21.5-48-48-48L48 64zm192 0c-26.5 0-48 21.5-48 48l0 288c0 26.5 21.5 48 48 48l32 0c26.5 0 48-21.5 48-48l0-288c0-26.5-21.5-48-48-48l-32 0z', c: '#cbd5e1' },
    play: { vb: '0 0 384 512', d: 'M73 39c-14.8-9.1-33.4-9.4-48.5-.9S0 62.6 0 80L0 432c0 17.4 9.4 33.4 24.5 41.9s33.7 8.1 48.5-.9L361 297c14.3-8.7 23-24.2 23-41s-8.7-32.2-23-41L73 39z', c: '#cbd5e1' },
    plus: { vb: '0 0 448 512', d: 'M256 80c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 144L48 224c-17.7 0-32 14.3-32 32s14.3 32 32 32l144 0 0 144c0 17.7 14.3 32 32 32s32-14.3 32-32l0-144 144 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-144 0 0-144z', c: '#cbd5e1' },
    rotate_right: { vb: '0 0 512 512', d: 'M463.5 224l8.5 0c13.3 0 24-10.7 24-24l0-128c0-9.7-5.8-18.5-14.8-22.2s-19.3-1.7-26.2 5.2L413.4 96.6c-87.6-86.5-228.7-86.2-315.8 1c-87.5 87.5-87.5 229.3 0 316.8s229.3 87.5 316.8 0c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0c-62.5 62.5-163.8 62.5-226.3 0s-62.5-163.8 0-226.3c62.2-62.2 162.7-62.5 225.3-1L327 183c-6.9 6.9-8.9 17.2-5.2 26.2s12.5 14.8 22.2 14.8l119.5 0z', c: '#cbd5e1' },
    scissors: { vb: '0 0 512 512', d: 'M256 192l-39.5-39.5c4.9-12.6 7.5-26.2 7.5-40.5C224 50.1 173.9 0 112 0S0 50.1 0 112s50.1 112 112 112c14.3 0 27.9-2.7 40.5-7.5L192 256l-39.5 39.5c-12.6-4.9-26.2-7.5-40.5-7.5C50.1 288 0 338.1 0 400s50.1 112 112 112s112-50.1 112-112c0-14.3-2.7-27.9-7.5-40.5L499.2 76.8c7.1-7.1 7.1-18.5 0-25.6c-28.3-28.3-74.1-28.3-102.4 0L256 192zm22.6 150.6L396.8 460.8c28.3 28.3 74.1 28.3 102.4 0c7.1-7.1 7.1-18.5 0-25.6L342.6 278.6l-64 64zM64 112a48 48 0 1 1 96 0 48 48 0 1 1 -96 0zm48 240a48 48 0 1 1 0 96 48 48 0 1 1 0-96z', c: '#cbd5e1' },
    sequence: { vb: '0 0 512 512', d: 'M0 128C0 92.7 28.7 64 64 64H448c35.3 0 64 28.7 64 64V384c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V128zm32 32v32c0 8.8 7.2 16 16 16H80c8.8 0 16-7.2 16-16V160c0-8.8-7.2-16-16-16H48c-8.8 0-16 7.2-16 16zm384 0v32c0 8.8 7.2 16 16 16h32c8.8 0 16-7.2 16-16V160c0-8.8-7.2-16-16-16H432c-8.8 0-16 7.2-16 16zM32 288v32c0 8.8 7.2 16 16 16H80c8.8 0 16-7.2 16-16V288c0-8.8-7.2-16-16-16H48c-8.8 0-16 7.2-16 16zm384 0v32c0 8.8 7.2 16 16 16h32c8.8 0 16-7.2 16-16V288c0-8.8-7.2-16-16-16H432c-8.8 0-16 7.2-16 16zM160 160V352c0 17.7 14.3 32 32 32H320c17.7 0 32-14.3 32-32V160c0-17.7-14.3-32-32-32H192c-17.7 0-32 14.3-32 32z', c: '#ec4899' },
    trash: { vb: '0 0 448 512', d: 'M135.2 17.7L128 32 32 32C14.3 32 0 46.3 0 64S14.3 96 32 96l384 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-96 0-7.2-14.3C307.4 6.8 296.3 0 284.2 0L163.8 0c-12.1 0-23.2 6.8-28.6 17.7zM416 128L32 128 53.2 467c1.6 25.3 22.6 45 47.9 45l245.8 0c25.3 0 46.3-19.7 47.9-45L416 128z', c: '#ef4444' },
    video: { vb: '0 0 576 512', d: 'M0 128C0 92.7 28.7 64 64 64H320c35.3 0 64 28.7 64 64V384c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V128zM559.1 99.8c10.4 5.6 16.9 16.4 16.9 28.2V384c0 11.8-6.5 22.6-16.9 28.2s-23 5-32.9-1.6l-96-64L416 337.1V320 192 174.9l14.2-9.5 96-64c9.8-6.5 22.4-7.2 32.9-1.6z', c: '#22c55e' },
    wave_square: { vb: '0 0 640 512', d: 'M128 64c0-17.7 14.3-32 32-32l160 0c17.7 0 32 14.3 32 32l0 352 96 0 0-160c0-17.7 14.3-32 32-32l128 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-96 0 0 160c0 17.7-14.3 32-32 32l-160 0c-17.7 0-32-14.3-32-32l0-352-96 0 0 160c0 17.7-14.3 32-32 32L32 288c-17.7 0-32-14.3-32-32s14.3-32 32-32l96 0 0-160z', c: '#cbd5e1' },
    magnifying_glass: { vb: '0 0 512 512', d: 'M416 208c0 45.9-14.9 88.3-40 122.7L502.6 457.4c12.5 12.5 12.5 32.8 0 45.3s-32.8 12.5-45.3 0L330.7 376c-34.4 25.2-76.8 40-122.7 40C93.1 416 0 322.9 0 208S93.1 0 208 0S416 93.1 416 208zM208 352a144 144 0 1 0 0-288 144 144 0 1 0 0 288z', c: '#cbd5e1' },
    stop: { vb: '0 0 384 512', d: 'M0 128C0 92.7 28.7 64 64 64H320c35.3 0 64 28.7 64 64V384c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V128z', c: '#cbd5e1' },
    comment_dots: { vb: '0 0 512 512', d: 'M256 448c141.4 0 256-93.1 256-208S397.4 32 256 32S0 125.1 0 240c0 45.1 17.7 86.8 47.7 120.9c-1.9 24.5-11.4 46.3-21.4 62.9c-5.5 9.2-11.1 16.6-15.2 21.6c-2.1 2.5-3.7 4.4-4.9 5.7c-.6 .6-1 1.1-1.3 1.4l-.3 .3c0 0 0 0 0 0c0 0 0 0 0 0s0 0 0 0s0 0 0 0c-4.6 4.6-5.9 11.4-3.4 17.4c2.5 6 8.3 9.9 14.8 9.9c28.7 0 57.6-8.9 81.6-19.3c22.9-10 42.4-21.9 54.3-30.6c31.8 11.5 67 17.9 104.1 17.9zM128 208a32 32 0 1 1 0 64 32 32 0 1 1 0-64zm128 0a32 32 0 1 1 0 64 32 32 0 1 1 0-64zm96 32a32 32 0 1 1 64 0 32 32 0 1 1 -64 0z', c: '#cbd5e1' },
    arrow_left: { vb: '0 0 448 512', d: 'M9.4 233.4c-12.5 12.5-12.5 32.8 0 45.3l160 160c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L109.2 288 416 288c17.7 0 32-14.3 32-32s-14.3-32-32-32l-306.7 0L214.6 118.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0l-160 160z', c: '#cbd5e1' },
    rotate_left: { vb: '0 0 512 512', d: 'M125.7 160l50.3 0c17.7 0 32 14.3 32 32s-14.3 32-32 32L48 224c-17.7 0-32-14.3-32-32L16 64c0-17.7 14.3-32 32-32s32 14.3 32 32l0 51.2L97.6 97.6c87.5-87.5 229.3-87.5 316.8 0s87.5 229.3 0 316.8s-229.3 87.5-316.8 0c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0c62.5 62.5 163.8 62.5 226.3 0s62.5-163.8 0-226.3s-163.8-62.5-226.3 0L125.7 160z', c: '#cbd5e1' },
    wand_magic_sparkles: { vb: '0 0 576 512', d: 'M234.7 42.7L197 56.8c-3 1.1-5 4-5 7.2s2 6.1 5 7.2l37.7 14.1L248.8 123c1.1 3 4 5 7.2 5s6.1-2 7.2-5l14.1-37.7L315 71.2c3-1.1 5-4 5-7.2s-2-6.1-5-7.2L277.3 42.7 263.2 5c-1.1-3-4-5-7.2-5s-6.1 2-7.2 5L234.7 42.7zM46.1 395.4c-18.7 18.7-18.7 49.1 0 67.9l34.6 34.6c18.7 18.7 49.1 18.7 67.9 0L529.9 116.5c18.7-18.7 18.7-49.1 0-67.9L495.3 14.1c-18.7-18.7-49.1-18.7-67.9 0L46.1 395.4zM484.6 82.6l-105 105-23.3-23.3 105-105 23.3 23.3zM7.5 117.2C3 118.9 0 123.2 0 128s3 9.1 7.5 10.8L64 160l21.2 56.5c1.7 4.5 6 7.5 10.8 7.5s9.1-3 10.8-7.5L128 160l56.5-21.2c4.5-1.7 7.5-6 7.5-10.8s-3-9.1-7.5-10.8L128 96 106.8 39.5C105.1 35 100.8 32 96 32s-9.1 3-10.8 7.5L64 96 7.5 117.2zm352 256c-4.5 1.7-7.5 6-7.5 10.8s3 9.1 7.5 10.8L416 416l21.2 56.5c1.7 4.5 6 7.5 10.8 7.5s9.1-3 10.8-7.5L480 416l56.5-21.2c4.5-1.7 7.5-6 7.5-10.8s-3-9.1-7.5-10.8L480 352l-21.2-56.5c-1.7-4.5-6-7.5-10.8-7.5s-9.1 3-10.8 7.5L416 352l-56.5 21.2z', c: '#c084fc' },
    xmark: { vb: '0 0 384 512', d: 'M342.6 150.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L192 210.7 86.6 105.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L146.7 256 41.4 361.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L192 301.3 297.4 406.6c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L237.3 256 342.6 150.6z', c: '#cbd5e1' }
};
function pluginIconSVG(name, size, colorOverride) {
  var ic = PI_ICONS[name] || PI_ICONS.file;
  var s = size || 14;
  return '<svg viewBox="' + ic.vb + '" width="' + s + '" height="' + s + '"><path fill="' + (colorOverride || ic.c) + '" d="' + ic.d + '"/></svg>';
}
// Fill <span data-ic="NAME"> placeholders with an inline <svg> (UXP renders inline
// SVG inside DIV/SPAN — but NOT inside <button>, which is text-only; icon hosts
// must therefore be a div/span, not a button).
function pluginRenderIcons(root) {
  var els = (root || document).querySelectorAll('[data-ic]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (el.getAttribute('data-ic-done') === '1') continue;
    el.classList.add('p-ic');
    el.innerHTML = pluginIconSVG(el.getAttribute('data-ic'), parseInt(el.getAttribute('data-ic-size'), 10) || 0, el.getAttribute('data-ic-color') || null);
    el.setAttribute('data-ic-done', '1');
  }
}
window.pluginIconSVG = pluginIconSVG;
window.pluginRenderIcons = pluginRenderIcons;

// UXP <button> cannot render child elements (icons), so icon-bearing buttons are
// authored as <div role="button">. Native <button>.disabled doesn't exist on a div,
// so we install a virtual `disabled` property that mirrors a CSS class — existing
// code like `btn.disabled = true` then keeps working unchanged on the div.
function piMakeButton(el) {
  if (!el || el.__piBtn || el.tagName === 'BUTTON') return el;
  el.__piBtn = true;
  try {
    Object.defineProperty(el, 'disabled', {
      configurable: true,
      get: function () { return el.classList.contains('is-disabled'); },
      set: function (v) {
        if (v) { el.classList.add('is-disabled'); el.setAttribute('aria-disabled', 'true'); }
        else { el.classList.remove('is-disabled'); el.removeAttribute('aria-disabled'); }
      }
    });
  } catch (e) {}
  return el;
}
window.piMakeButton = piMakeButton;
// Set a button's content to an inline icon (optionally followed by a text label).
// Use for dynamically-created or state-toggling buttons (play/pause/stop) so they
// stay flat-icon instead of falling back to emoji glyphs.
function piSetBtn(el, iconName, label, color, size) {
  if (!el) return;
  var ic = '<span class="p-ic">' + pluginIconSVG(iconName, size || (label ? 13 : 12), color || null) + '</span>';
  el.innerHTML = label ? (ic + ' ' + label) : ic;
}
window.piSetBtn = piSetBtn;
function pluginInitButtons(root) {
  var els = (root || document).querySelectorAll('div[role="button"]');
  for (var i = 0; i < els.length; i++) piMakeButton(els[i]);
}
window.pluginInitButtons = pluginInitButtons;

// ── Accent theming ─────────────────────────────────────────────────────────
// The whole UI's purple is driven by --accent + derived shade/opacity vars.
// rgba(var()) is unreliable in UXP, so we COMPUTE every shade as a literal in JS
// and set it as a plain CSS variable (which UXP substitutes fine).
var PI_ACCENT_OPACITIES = [4, 6, 7, 8, 10, 12, 15, 18, 20, 22, 25, 28, 30, 35, 40, 45, 50, 60, 70];
var PI_ACCENT_PRESETS = [
  { name: 'Violet',  hex: '#a855f7' },
  { name: 'Blue',    hex: '#3b82f6' },
  { name: 'Emerald', hex: '#10b981' },
  { name: 'Amber',   hex: '#f59e0b' },
  { name: 'Rose',    hex: '#f43f5e' }
];
function piHexToRgb(h) {
  h = String(h || '').replace('#', '').trim();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  var n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function piRgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  var mx = Math.max(r, g, b), mn = Math.min(r, g, b), h = 0, s = 0, l = (mx + mn) / 2;
  if (mx !== mn) {
    var d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}
function piHslToHex(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  function hue(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }
  var r, g, b;
  if (s === 0) { r = g = b = l; }
  else { var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3); }
  function tohex(x) { var v = Math.round(x * 255).toString(16); return v.length === 1 ? '0' + v : v; }
  return '#' + tohex(r) + tohex(g) + tohex(b);
}
function piApplyAccent(hex) {
  var rgb = piHexToRgb(hex);
  if (!rgb) return false;
  try {
    var hsl = piRgbToHsl(rgb.r, rgb.g, rgb.b);
    var root = document.documentElement.style;
    root.setProperty('--accent', hex);
    root.setProperty('--accent-rgb', rgb.r + ', ' + rgb.g + ', ' + rgb.b);
    // Auto-contrast: text/icon colour to put ON an accent-filled surface.
    // Perceived luminance > 0.6 → the accent is light → use dark text, else white.
    var lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    root.setProperty('--accent-fg', lum > 0.6 ? '#1a1a1a' : '#ffffff');
    root.setProperty('--accent-light',   piHslToHex(hsl.h, Math.min(100, hsl.s), Math.min(100, hsl.l + 12)));
    root.setProperty('--accent-lighter', piHslToHex(hsl.h, Math.min(100, hsl.s), Math.min(100, hsl.l + 24)));
    root.setProperty('--accent-dark',    piHslToHex(hsl.h, hsl.s, Math.max(0, hsl.l - 12)));
    PI_ACCENT_OPACITIES.forEach(function (o) {
      root.setProperty('--accent-a' + (o < 10 ? '0' + o : o), 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + (o / 100) + ')');
    });
    try { localStorage.setItem('pi_accent', hex); } catch (e) {}
    return true;
  } catch (e) { return false; }
}
function piInitAccent() {
  var saved = null;
  try { saved = localStorage.getItem('pi_accent'); } catch (e) {}
  piApplyAccent(saved || '#a855f7');
}
window.piApplyAccent = piApplyAccent;
window.PI_ACCENT_PRESETS = PI_ACCENT_PRESETS;
// User-saved custom accent presets (localStorage). Built-ins are never stored here.
function piGetCustoms() { try { return JSON.parse(localStorage.getItem('pi_accent_customs') || '[]'); } catch (e) { return []; } }
function piSaveCustoms(arr) { try { localStorage.setItem('pi_accent_customs', JSON.stringify(arr)); } catch (e) {} }
function piAddCustom(hex) {
  hex = String(hex).toLowerCase();
  if (PI_ACCENT_PRESETS.some(function (p) { return p.hex.toLowerCase() === hex; })) return; // already a built-in
  var arr = piGetCustoms();
  if (arr.map(function (h) { return h.toLowerCase(); }).indexOf(hex) !== -1) return;        // already saved
  arr.push(hex);
  if (arr.length > 12) arr = arr.slice(arr.length - 12);
  piSaveCustoms(arr);
}
function piRemoveCustom(hex) {
  hex = String(hex).toLowerCase();
  piSaveCustoms(piGetCustoms().filter(function (h) { return h.toLowerCase() !== hex; }));
}
// Render the preset swatches + custom-colour input in Settings; wire to piApplyAccent.
function piRenderAccentUI() {
  var wrap = document.getElementById('accentSwatches');
  if (!wrap) return;
  var current = '#a855f7';
  try { current = (localStorage.getItem('pi_accent') || '#a855f7'); } catch (e) {}
  current = String(current).toLowerCase();
  wrap.innerHTML = '';
  PI_ACCENT_PRESETS.forEach(function (p) {
    var sw = document.createElement('div');
    sw.className = 'accent-swatch' + (p.hex.toLowerCase() === current ? ' is-active' : '');
    sw.style.background = p.hex;
    sw.title = p.name;
    sw.addEventListener('click', function () { piApplyAccent(p.hex); piRenderAccentUI(); });
    wrap.appendChild(sw);
  });
  // User custom presets — removable via a × on hover.
  piGetCustoms().forEach(function (hex) {
    var sw = document.createElement('div');
    sw.className = 'accent-swatch accent-swatch-custom' + (hex.toLowerCase() === current ? ' is-active' : '');
    sw.style.background = hex;
    sw.title = hex;
    sw.addEventListener('click', function () { piApplyAccent(hex); piRenderAccentUI(); });
    var del = document.createElement('span');
    del.className = 'accent-swatch-del';
    del.textContent = '×';
    del.title = 'Xoá màu này';
    del.addEventListener('click', function (e) { e.stopPropagation(); piRemoveCustom(hex); piRenderAccentUI(); });
    sw.appendChild(del);
    wrap.appendChild(sw);
  });
  // Custom hex input (UXP has no <input type=color>) — "+" toggles a hex field.
  var addBtn = document.getElementById('accentAddBtn');
  var row = document.getElementById('accentCustomRow');
  var hexIn = document.getElementById('accentHex');
  var apply = document.getElementById('accentHexApply');
  if (addBtn && !addBtn.__wired) {
    addBtn.__wired = true;
    addBtn.addEventListener('click', function () {
      if (!row) return;
      var show = row.hasAttribute('hidden');
      if (show) { row.removeAttribute('hidden'); if (hexIn) { hexIn.value = current; try { hexIn.focus(); } catch (e) {} } }
      else row.setAttribute('hidden', '');
    });
  }
  if (hexIn && !hexIn.__wired) {
    hexIn.__wired = true;
    hexIn.addEventListener('focus', function () { if (window.claimKeyboard) window.claimKeyboard(); });
    hexIn.addEventListener('blur',  function () { if (window.releaseKeyboard) window.releaseKeyboard(); });
    hexIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); piAccentApplyHex(); } });
  }
  if (apply && !apply.__wired) {
    apply.__wired = true;
    apply.addEventListener('click', piAccentApplyHex);
  }
}
// Validate + apply the hex from the custom input; ignore invalid input.
function piAccentApplyHex() {
  var hexIn = document.getElementById('accentHex');
  if (!hexIn) return;
  var v = String(hexIn.value || '').trim();
  if (v && v[0] !== '#') v = '#' + v;
  if (!piHexToRgb(v)) { hexIn.style.borderColor = '#ef4444'; return; }
  hexIn.style.borderColor = '';
  piApplyAccent(v);
  piAddCustom(v);   // saving the colour turns it into a removable preset swatch
  var row = document.getElementById('accentCustomRow');
  if (row) row.setAttribute('hidden', '');
  piRenderAccentUI();
}
window.piRenderAccentUI = piRenderAccentUI;

// Render placeholders now + a couple of deferred passes (UXP's DOMContentLoaded
// is unreliable; main.js runs at body end so the DOM is already parsed).
function _piRenderSafe() { try { pluginRenderIcons(document); pluginInitButtons(document); piRenderAccentUI(); } catch (e) {} }
try { piInitAccent(); } catch (e) {}   // apply saved accent ASAP (before first paint)
_piRenderSafe();
setTimeout(_piRenderSafe, 0);
setTimeout(_piRenderSafe, 500);

// Convert any TickTime/time object to seconds
// Premiere Pro 25.x TickTime has non-enumerable getters — try everything
function getTimeSec(t) {
  if (!t && t !== 0) return 0;
  if (typeof t === 'number') return t;
  if (typeof t.seconds === 'number') return t.seconds;
  if (typeof t.ticks   === 'number') return t.ticks / 254016000000;
  try { var s = t.seconds; if (typeof s === 'number') return s; } catch(e) {}
  try { var tk = t.ticks;  if (typeof tk === 'number') return tk / 254016000000; } catch(e) {}
  if (typeof t.getSeconds === 'function') { try { return t.getSeconds(); } catch(e) {} }
  if (typeof t.getValue   === 'function') { try { return t.getValue();   } catch(e) {} }
  if (t.time != null) return getTimeSec(t.time);
  return 0;
}
function secToTicks(s) { return Math.round((s || 0) * 254016000000); }

// Collection helper: works for both array and {numX, [i]} style collections
function collectionToArray(col) {
  if (!col) return [];
  if (Array.isArray(col)) return col;
  var count = col.numTracks || col.numItems || col.numSequences || col.length || 0;
  var arr = [];
  for (var i = 0; i < count; i++) arr.push(col[i]);
  return arr;
}

async function getActiveProject() {
  if (!ppro) throw new Error('Premiere API not available');
  // Modern UXP API: ppro.Project.getActiveProject() (async)
  if (ppro.Project && typeof ppro.Project.getActiveProject === 'function') {
    var p = await ppro.Project.getActiveProject();
    if (p) return p;
  }
  // Fallback: sync property paths
  var p2 = (ppro.app && ppro.app.project) || ppro.project || null;
  if (p2) return p2;
  throw new Error('No project open in Premiere');
}

async function getActiveSequence() {
  var proj = await getActiveProject();

  // 1. Async method (Premiere Pro 23+)
  if (typeof proj.getActiveSequence === 'function') {
    var s = await proj.getActiveSequence();
    if (s) return s;
  }
  // 2. Sync property
  if (proj.activeSequence) return proj.activeSequence;

  // DO NOT fall back to seqs[0] — that always returns the first sequence
  // regardless of which one is actually open in the timeline panel.
  throw new Error('No active sequence. Double-click a sequence in Premiere to open it.');
}

// ── Track/clip access ─────────────────────────────────────────────────────
// Confirmed API from Adobe DVA internal UXP plugins (com.adobe.dva.text):
//   seq.trackGroup(ppro.Backend.MEDIATYPE_VIDEO)  → TrackGroup (sync)
//   trackGroup.numTracks                           → count (property)
//   trackGroup.getTrack(i)                         → Track (sync)
//   ppro.ClipTrack.queryCast(track)                → ClipTrack or null
//   clipTrack.getTrackItems(1, false)              → TrackItem[] (1=CLIP type)
//   item.getStart()                                → TickTime {seconds, ticks}
//   item.getDuration()                             → TickTime {seconds, ticks}
// TrackItemType: EMPTY=0, CLIP=1, TRANSITION=2, PREVIEW=3

var TRACK_ITEM_TYPE_CLIP = 1; // from enum: e[e.CLIP=1]="CLIP"

// getTimeSec (above) handles all TickTime cases — getTickTimeSec is an alias
// kept here for internal calls within track/clip section:

// Get all clip items from a track.
// Method A (preferred): ClipTrack.queryCast(track).getTrackItems(CLIP=1, false)
// Method B (fallback):  track.getTrackItems(CLIP=1, false)  ← same signature, direct call
// The signature is (TrackItemType, includeDisabled) — NOT (startTicks, endTicks)!
// TrackItemType: EMPTY=0, CLIP=1, TRANSITION=2 (confirmed from DVA text plugin enum)
async function getClipItems(track) {
  if (!track) return [];
  try {
    // Method A: queryCast (cleaner, handles caption-only tracks gracefully)
    if (ppro.ClipTrack) {
      var ct = ppro.ClipTrack.queryCast(track);
      if (ct) {
        var items = ct.getTrackItems(TRACK_ITEM_TYPE_CLIP, false);
        if (items && typeof items.then === 'function') items = await items;
        if (!items) return [];
        return Array.isArray(items) ? items : Array.from({length: items.length||0}, function(_,i){return items[i];});
      }
    }
    // Method B: call directly on the track object
    var items2 = track.getTrackItems(TRACK_ITEM_TYPE_CLIP, false);
    if (items2 && typeof items2.then === 'function') items2 = await items2;
    if (!items2) return [];
    return Array.isArray(items2) ? items2 : Array.from({length: items2.length||0}, function(_,i){return items2[i];});
  } catch(e) {
    console.warn('[Plugin] getClipItems error on track:', e.message);
    return [];
  }
}

// Probe a clip on first call to log available properties
var _clipProbed = false;
function probeClipIfNeeded(clip) {
  if (_clipProbed || !clip) return;
  _clipProbed = true;
  var props = {};
  var KEYS = ['name','mediaType','type','inPoint','outPoint','start','end','duration',
               'getStart','getEnd','getInPoint','getOutPoint','getDuration','getGuid'];
  for (var i = 0; i < KEYS.length; i++) {
    try { var v = clip[KEYS[i]]; if (v !== undefined) props[KEYS[i]] = (typeof v === 'function') ? 'fn()' : String(v).slice(0,50); }
    catch(e) {}
  }
  // Try calling getStart
  try { var gs = clip.getStart(); props['getStart()'] = JSON.stringify({s: gs.seconds, t: gs.ticks}); } catch(e) {}
  try { var gd = clip.getDuration(); props['getDuration()'] = JSON.stringify({s: gd.seconds}); } catch(e) {}
  console.log('[Probe] ClipItem:', JSON.stringify(props));
}

// Helper: extract clip timing and push to array (async-aware)
async function pushClip(arr, item, trackIndex, trackType, clipIndex) {
  if (!item) return;
  probeClipIfNeeded(item);
  var startSec = 0, endSec = 0;
  // Modern Premiere UXP returns Promises from getters — await them
  try {
    var gs = item.getStart && item.getStart();
    if (gs && typeof gs.then === 'function') gs = await gs;
    startSec = (gs && typeof gs.seconds === 'number') ? gs.seconds
             : (gs && gs.ticks != null) ? Number(gs.ticks) / 254016000000 : 0;
  } catch(e) {}
  try {
    var ge = item.getEnd && item.getEnd();
    if (ge && typeof ge.then === 'function') ge = await ge;
    endSec = (ge && typeof ge.seconds === 'number') ? ge.seconds
           : (ge && ge.ticks != null) ? Number(ge.ticks) / 254016000000 : 0;
  } catch(e) {}
  // Fallback
  if (!startSec && !endSec) {
    startSec = getTimeSec(item.start || item.inPoint);
    endSec   = getTimeSec(item.end   || item.outPoint);
  }
  var name = item.name || '';
  if (!name && typeof item.getName === 'function') {
    try { var nm = item.getName(); if (nm && typeof nm.then === 'function') nm = await nm; if (nm) name = String(nm); } catch(e) {}
  }
  arr.push({ trackIndex: trackIndex, trackType: trackType, clipIndex: clipIndex,
    name: name || ('Clip ' + clipIndex), startSec: startSec, endSec: endSec });
}

// Get source file path from a timeline TrackItem.
// Tries getProjectItem() → ClipProjectItem.cast → getMediaFilePath, then
// .projectItem property, then direct item.getMediaFilePath as fallback.
async function vcGetTrackItemFilePath(item) {
  if (!item) return null;
  try {
    var pi = item.getProjectItem && item.getProjectItem();
    if (pi && typeof pi.then === 'function') pi = await pi;
    if (pi) {
      var cast = ppro && ppro.ClipProjectItem && ppro.ClipProjectItem.cast ? ppro.ClipProjectItem.cast(pi) : pi;
      var fp = (cast || pi).getMediaFilePath && (cast || pi).getMediaFilePath();
      if (fp && typeof fp.then === 'function') fp = await fp;
      if (typeof fp === 'string' && fp) return fp;
    }
  } catch(e) {}
  try {
    var pi2 = item.projectItem;
    if (pi2) {
      var cast2 = ppro && ppro.ClipProjectItem && ppro.ClipProjectItem.cast ? ppro.ClipProjectItem.cast(pi2) : pi2;
      var fp2 = (cast2 || pi2).getMediaFilePath && (cast2 || pi2).getMediaFilePath();
      if (fp2 && typeof fp2.then === 'function') fp2 = await fp2;
      if (typeof fp2 === 'string' && fp2) return fp2;
    }
  } catch(e) {}
  try {
    var fp3 = item.getMediaFilePath && item.getMediaFilePath();
    if (fp3 && typeof fp3.then === 'function') fp3 = await fp3;
    if (typeof fp3 === 'string' && fp3) return fp3;
  } catch(e) {}
  return null;
}

async function ppGetTimelineInfo() {
  try {
    var seq = await getActiveSequence();

    // ── Get tracks and clips ───────────────────────────────────────────────
    var clips = [], vCount = 0, aCount = 0, durationSec = 0;

    // Log available ppro API surface for debugging
    console.log('[Plugin] ppro.Backend:', typeof ppro.Backend,
                '| ppro.ClipTrack:', typeof ppro.ClipTrack,
                '| seq.trackGroup:', typeof seq.trackGroup);

    // ── Path A: trackGroup API (Adobe DVA internal plugins pattern) ──────
    // seq.trackGroup(mediaType) → sync TrackGroup {numTracks, getTrack(i)}
    var usedTrackGroup = false;
    if (typeof seq.trackGroup === 'function' && ppro.Backend && ppro.Backend.MEDIATYPE_VIDEO !== undefined) {
      try {
        var vGroup = seq.trackGroup(ppro.Backend.MEDIATYPE_VIDEO);
        var aGroup = seq.trackGroup(ppro.Backend.MEDIATYPE_AUDIO);
        if (vGroup && typeof vGroup.numTracks === 'number') {
          usedTrackGroup = true;
          vCount = vGroup.numTracks;
          aCount = (aGroup && typeof aGroup.numTracks === 'number') ? aGroup.numTracks : 0;
          console.log('[Plugin Path A] trackGroup vCount:', vCount, '| aCount:', aCount);
          for (var vi = 0; vi < vCount; vi++) {
            var vitems = await getClipItems(vGroup.getTrack(vi));
            console.log('[Plugin] Video track', vi, '→', vitems.length, 'clips');
            for (var ci = 0; ci < vitems.length; ci++) await pushClip(clips, vitems[ci], vi, 'video', ci);
          }
          for (var ai = 0; ai < aCount; ai++) {
            var aitems = await getClipItems(aGroup.getTrack(ai));
            console.log('[Plugin] Audio track', ai, '→', aitems.length, 'clips');
            for (var aci = 0; aci < aitems.length; aci++) await pushClip(clips, aitems[aci], ai, 'audio', aci);
          }
        }
      } catch(eA) { console.warn('[Plugin Path A] failed:', eA.message); }
    }

    // ── Path B: async getVideoTrack(i) + getClipItems (CLIP=1, false) ────
    // Works when trackGroup is unavailable. Uses same confirmed signature.
    if (!usedTrackGroup) {
      console.log('[Plugin Path B] using async getVideoTrack + getClipItems(1,false)');
      vCount = await seq.getVideoTrackCount();
      aCount = await seq.getAudioTrackCount();
      console.log('[Plugin Path B] vCount:', vCount, '| aCount:', aCount);
      for (var bvi = 0; bvi < vCount; bvi++) {
        var bvt = await seq.getVideoTrack(bvi);
        var bvitems = await getClipItems(bvt);
        console.log('[Plugin] Video track', bvi, '→', bvitems.length, 'clips');
        for (var bci = 0; bci < bvitems.length; bci++) await pushClip(clips, bvitems[bci], bvi, 'video', bci);
      }
      for (var bai = 0; bai < aCount; bai++) {
        var bat = await seq.getAudioTrack(bai);
        var baitems = await getClipItems(bat);
        console.log('[Plugin] Audio track', bai, '→', baitems.length, 'clips');
        for (var baci = 0; baci < baitems.length; baci++) await pushClip(clips, baitems[baci], bai, 'audio', baci);
      }
    }

    // Sequence duration
    try { var et = await seq.getEndTime(); durationSec = et.seconds || getTimeSec(et); } catch(e) {}
    console.log('[Plugin] Total clips:', clips.length, '| durationSec:', durationSec.toFixed(2));

    return { ok: true, data: {
      sequenceName:    seq.name,
      durationSec:     durationSec,
      videoTrackCount: vCount,
      audioTrackCount: aCount,
      clips:           clips
    }};
  } catch(e) {
    console.error('[Plugin] ppGetTimelineInfo error:', e.message, e.stack);
    return { ok: false, error: e.message };
  }
}

async function ppExecuteAction(actionObj) {
  var action = actionObj.action;
  try {
    if (action === 'get_timeline_info') return await ppGetTimelineInfo();

    // Push script/sfx text to Voice Gen tab (cross-tab communication)
    if (action === 'voicegen_script') {
      if (typeof window.VoiceGenPushScript === 'function') {
        window.VoiceGenPushScript(
          actionObj.text || '',
          actionObj.voiceId || null,
          !!actionObj.autoGenerate
        );
      }
      return { ok: true, data: { message: 'Script pushed to Voice Gen tab' } };
    }
    if (action === 'voicegen_sfx') {
      if (typeof window.VoiceGenPushSFX === 'function') {
        window.VoiceGenPushSFX(
          actionObj.text || '',
          !!actionObj.autoGenerate
        );
      }
      return { ok: true, data: { message: 'SFX prompt pushed to Voice Gen tab' } };
    }

    // Push an organized cutsheet into the Autocut tab's spreadsheet.
    // Accepts SAC-native rows {text, time, src} OR cutlist-style rows
    // {script, source, sourceIn, sourceOut} (seconds → "m:ss-m:ss").
    if (action === 'autocut_load') {
      var fmtSec = function(s) {
        s = Math.max(0, Math.round(Number(s) || 0));
        var m = Math.floor(s / 60), sec = s % 60;
        return m + ':' + (sec < 10 ? '0' + sec : sec);
      };
      var rawRows = Array.isArray(actionObj.rows) ? actionObj.rows : [];
      var rows = rawRows.map(function(r) {
        var text = r.text != null ? r.text : (r.script || '');
        var src  = r.src  != null ? r.src  : (r.source || '');
        var time = r.time || '';
        if (!time) {
          if (r.sourceIn != null && r.sourceOut != null) time = fmtSec(r.sourceIn) + '-' + fmtSec(r.sourceOut);
          else if (r.sourceIn != null) time = fmtSec(r.sourceIn);
        }
        return { text: String(text).trim(), time: String(time).trim(), src: String(src).trim() };
      });
      if (typeof window.AutocutPushRows === 'function') window.AutocutPushRows(rows);
      return { ok: true, data: { message: 'Loaded ' + rows.length + ' rows into Autocut tab' } };
    }

    var seq = await getActiveSequence();

    if (action === 'cut_clip') {
      // trackType: 'audio' or 'video' (default video). audioIndex/videoIndex maps to track.
      var trackType  = (actionObj.trackType || 'video').toLowerCase();
      var trackIdx   = actionObj.trackIndex || 0;
      var atSec      = Number(actionObj.time || 0);
      var trackObj   = trackType === 'audio'
        ? await seq.getAudioTrack(trackIdx)
        : await seq.getVideoTrack(trackIdx);
      if (!trackObj) throw new Error(trackType + ' track ' + trackIdx + ' not found');

      // Find the trackItem that contains atSec on its timeline range (inline async probe)
      async function clipStart(item) {
        try { var gs = await item.getStart(); return (gs && gs.seconds) || 0; } catch(e) { return 0; }
      }
      async function clipDur(item) {
        try {
          var gs = await item.getStart();
          var ge = await item.getEnd();
          return ((ge && ge.seconds) || 0) - ((gs && gs.seconds) || 0);
        } catch(e) { return 0; }
      }
      var items = await getClipItems(trackObj);
      var target = null;
      console.log('[cut_clip] scanning', items.length, 'items on', trackType, 'track', trackIdx, 'for time', atSec);
      for (var i = 0; i < items.length; i++) {
        var s = await clipStart(items[i]);
        var d = await clipDur(items[i]);
        console.log('[cut_clip]   [' + i + '] "' + (items[i].name || '?') + '" start=' + s + ' dur=' + d);
        if (atSec > s + 0.001 && atSec < s + d - 0.001) {
          target = { item: items[i], startSec: s, durSec: d };
          break;
        }
      }
      if (!target) throw new Error('No ' + trackType + ' clip on track ' + trackIdx + ' contains time ' + atSec + 's');

      // Try multiple razor approaches — UXP API varies
      var atTick = ppro.TickTime.createWithSeconds(atSec);
      var project = await getActiveProject();
      var razorDone = false;

      // Approach 1: sequence-level razor methods
      try {
        if (typeof seq.razor === 'function') {
          var r = seq.razor(atTick);
          if (r && typeof r.then === 'function') await r;
          razorDone = true;
        } else if (typeof seq.razorAll === 'function') {
          var ra = seq.razorAll(atTick);
          if (ra && typeof ra.then === 'function') await ra;
          razorDone = true;
        }
      } catch(e) { console.warn('[cut_clip] razor() failed:', e.message); }

      // Approach 2: SequenceEditor createRazorAction (if exists)
      if (!razorDone && ppro.SequenceEditor) {
        try {
          var editor = ppro.SequenceEditor.getEditor(seq);
          if (editor && typeof editor.createRazorAction === 'function') {
            await project.lockedAccess(function() {
              project.executeTransaction(function(action) {
                action.addAction(editor.createRazorAction(atTick));
              }, 'Razor at ' + atSec + 's');
            });
            razorDone = true;
          } else if (editor && typeof editor.createRazorAtTimeAction === 'function') {
            await project.lockedAccess(function() {
              project.executeTransaction(function(action) {
                action.addAction(editor.createRazorAtTimeAction(atTick));
              }, 'Razor at ' + atSec + 's');
            });
            razorDone = true;
          }
        } catch(e) { console.warn('[cut_clip] editor.createRazorAction failed:', e.message); }
      }

      // Approach 3: trackItem split (if available)
      if (!razorDone) {
        try {
          if (typeof target.item.createSplitAction === 'function') {
            await project.lockedAccess(function() {
              project.executeTransaction(function(action) {
                action.addAction(target.item.createSplitAction(atTick));
              }, 'Split at ' + atSec + 's');
            });
            razorDone = true;
          }
        } catch(e) { console.warn('[cut_clip] split failed:', e.message); }
      }

      if (!razorDone) {
        // No razor API available — dump what we know
        var seqMethods = [];
        for (var k in seq) if (typeof seq[k] === 'function' && /razor|split|cut/i.test(k)) seqMethods.push(k);
        var edMethods = [];
        if (ppro.SequenceEditor) {
          try {
            var ed = ppro.SequenceEditor.getEditor(seq);
            for (var k2 in ed) if (typeof ed[k2] === 'function' && /razor|split|cut/i.test(k2)) edMethods.push(k2);
          } catch(e) {}
        }
        throw new Error('No razor API in this Premiere version. Tried: seq.razor, editor.createRazorAction, item.createSplitAction. seq methods found: [' + seqMethods.join(',') + '], editor methods: [' + edMethods.join(',') + ']');
      }
      return { ok: true, data: { message: 'Razor cut ' + trackType + ' track ' + trackIdx + ' at ' + atSec + 's' } };
    }
    if (action === 'add_marker') {
      var m = await seq.markers.createMarker(secToTicks(actionObj.time));
      if (actionObj.name) m.name = actionObj.name;
      return { ok: true, data: { message: 'Marker "' + actionObj.name + '" added at ' + actionObj.time + 's' } };
    }
    if (action === 'add_subtitle') {
      var ct     = collectionToArray(seq.captionTracks);
      var ctrack = ct[actionObj.captionTrackIndex || 0];
      if (!ctrack) throw new Error('No caption track found. Create one in Premiere first.');
      var clipEl = await ctrack.createCaption(
        { ticks: secToTicks(actionObj.startTime) },
        { ticks: secToTicks(actionObj.endTime) });
      if (clipEl) clipEl.text = actionObj.text;
      return { ok: true, data: { message: 'Subtitle added: "' + actionObj.text + '"' } };
    }
    if (action === 'set_volume') {
      var atrack = collectionToArray(seq.audioTracks)[actionObj.trackIndex];
      var aclip  = atrack && collectionToArray(atrack.clips)[actionObj.clipIndex];
      if (!aclip) throw new Error('Audio clip not found');
      var comps = collectionToArray(aclip.audioComponents);
      for (var i = 0; i < comps.length; i++) {
        if (comps[i].displayName === 'Volume') {
          comps[i].properties.getPropertyByDisplayName('Level').setValue(actionObj.volumeDb, true);
          break;
        }
      }
      return { ok: true, data: { message: 'Volume set to ' + actionObj.volumeDb + 'dB' } };
    }
    if (action === 'move_clip') {
      var mvtrack = collectionToArray(seq.videoTracks)[actionObj.trackIndex];
      var mvclip  = mvtrack && collectionToArray(mvtrack.clips)[actionObj.clipIndex];
      if (!mvclip) throw new Error('Clip not found');
      mvclip.start = { ticks: secToTicks(actionObj.newStart) };
      return { ok: true, data: { message: 'Clip moved to ' + actionObj.newStart + 's' } };
    }
    if (action === 'trim_clip') {
      var tmtrack = collectionToArray(seq.videoTracks)[actionObj.trackIndex];
      var tmclip  = tmtrack && collectionToArray(tmtrack.clips)[actionObj.clipIndex];
      if (!tmclip) throw new Error('Clip not found');
      if (actionObj.newIn  != null) tmclip.inPoint  = { ticks: secToTicks(actionObj.newIn) };
      if (actionObj.newOut != null) tmclip.outPoint = { ticks: secToTicks(actionObj.newOut) };
      return { ok: true, data: { message: 'Clip trimmed' } };
    }
    return { ok: false, error: 'Unknown action: ' + action };
  } catch(e) { return { ok: false, error: e.message }; }
}

// ── Premiere event listeners (real-time sequence tracking) ─────────────────

async function registerTimelineEvents() {
  if (!ppro) return;

  var handler = function() {
    console.log('[Plugin] Sequence change detected');
    refreshTimeline();
  };

  // Candidate event names across different Premiere Pro versions
  var EVENT_NAMES = [
    'onActiveSequenceChanged',
    'activeSequenceChanged',
    'onSequenceActivated',
    'sequenceActivated',
    'onActiveItemChanged',
  ];

  // Candidate objects to attach listeners to
  var targets = [ppro, ppro.app, ppro.Project].filter(Boolean);

  // Also try the project instance
  try {
    var proj = await getActiveProject();
    if (proj) targets.push(proj);
  } catch(e) {}

  var registered = 0;
  targets.forEach(function(target) {
    if (typeof target.addEventListener !== 'function') return;
    EVENT_NAMES.forEach(function(name) {
      try {
        target.addEventListener(name, handler);
        registered++;
        console.log('[Plugin] Listening:', name, 'on', target);
      } catch(e) { /* not supported */ }
    });
  });

  // Also listen to VideoTrack/AudioTrack class-level events (track content changes)
  var TRACK_EVENTS = [
    ppro.VideoTrack && ppro.VideoTrack.EVENT_TRACK_CHANGED,
    ppro.VideoTrack && ppro.VideoTrack.EVENT_TRACK_INFO_CHANGED,
    ppro.AudioTrack && ppro.AudioTrack.EVENT_TRACK_CHANGED,
  ].filter(Boolean);

  TRACK_EVENTS.forEach(function(evtName) {
    try {
      ppro.app && ppro.app.addEventListener(evtName, handler);
    } catch(e) {}
  });

  console.log('[Plugin] Event registrations attempted:', registered);
}

// ── Version ────────────────────────────────────────────────────────────────
var PLUGIN_VERSION = 'v4.9.6';  // Hotkey: bắt buộc ≥1 modifier (⌘/⌥/⌃) — bỏ AX/Accessibility; chỉ đăng ký khi Premiere frontmost + định tuyến đa phiên bản + cảnh báo trùng. On top of v4.9.2

// ── State ──────────────────────────────────────────────────────────────────

var BRIDGE_URL      = 'http://localhost:3030';
var CLAUDE_MODEL    = 'claude-sonnet-4-6';
var ANTHROPIC_KEY   = ''; // user-provided API key (optional)
var GEMINI_KEY      = ''; // user-provided Gemini key for Organize (optional; bridge .env is fallback)
// Raw saved pick (rỗng nếu user chưa từng đổi dropdown). KHÔNG fallback ở đây —
// giá trị mặc định được tính động trong sacResolveOrganizeModel() (phụ thuộc có key Gemini hay chưa).
var ORGANIZE_MODEL  = localStorage.getItem('sac_organize_model') || '';
var ORGANIZE_MODELS = ['gemini-3.1-flash-lite', 'claude-sonnet-4-6']; // chỉ 2 model: Gemini (default) + Sonnet (backup)
var ELEVENLABS_KEY  = ''; // no hardcoded key — user enters in Settings, or bridge .env (ELEVENLABS_API_KEY) provides the shared default
var EL_PROFILES     = []; // [{id, name, key}, ...] — saved ElevenLabs key profiles
var EL_ACTIVE_PROFILE_ID = null; // id of the profile whose key is in ELEVENLABS_KEY

// Model dùng cho Organize. Ưu tiên lựa chọn thủ công còn hợp lệ của user; nếu chưa
// chọn (hoặc giá trị cũ đã bị bỏ) → mặc định Gemini 3.1 Flash Lite CHỈ KHI đã có key
// Gemini, ngược lại dùng Sonnet 4.6 (chạy qua CLI, không cần key).
function sacResolveOrganizeModel() {
  if (ORGANIZE_MODELS.indexOf(ORGANIZE_MODEL) >= 0) return ORGANIZE_MODEL;
  return GEMINI_KEY ? 'gemini-3.1-flash-lite' : 'claude-sonnet-4-6';
}
// Đồng bộ 2 dropdown Organize về model đang hiệu lực (gọi khi load + khi đổi key).
window.sacSyncOrganizeModelUI = function() {
  var m = sacResolveOrganizeModel();
  var a = document.getElementById('sacAiModel');      if (a) a.value = m;
  var b = document.getElementById('vgOrganizeModel'); if (b) b.value = m;
};

// Resolve the provider/model/key for script "Organize" from the selected model.
// gemini* → Gemini (key = GEMINI_KEY or bridge .env); else Anthropic (key = ANTHROPIC_KEY or bridge).
window.sacOrganizeConfig = function() {
  var m = sacResolveOrganizeModel();
  var isGemini = /^gemini/i.test(m);
  return {
    provider: isGemini ? 'gemini' : 'anthropic',
    model: m,
    apiKey: isGemini ? GEMINI_KEY : ANTHROPIC_KEY, // empty → bridge falls back to its .env / CLI
  };
};
var RATE_LIMIT_UNTIL = 0; // epoch ms — until when we shouldn't retry CLI
var messages        = [];
var timelineContext = null;
var isStreaming     = false;
var attachedImages  = []; // [{name, mediaType, base64, dataUrl}]

// ── DOM ────────────────────────────────────────────────────────────────────

var chatArea       = document.getElementById('chat-area');
var emptyState     = document.getElementById('empty-state');
var msgInput       = document.getElementById('message-input');
var sendBtn        = document.getElementById('send-btn');
var statusDot      = document.getElementById('status-dot');
var statusText     = document.getElementById('status-text');
var timelineInfo   = document.getElementById('timeline-info');
var contextPanel   = document.getElementById('context-panel');
var contextContent = document.getElementById('context-content');
var settingsModal  = document.getElementById('settings-modal');
// Settings used to live inside #tab-claude (now hidden). Reparent it to <body> so
// the ⚙ in the version bar can open it as a global overlay from any tab.
if (settingsModal && settingsModal.parentNode !== document.body) document.body.appendChild(settingsModal);
var bridgeUrlInput = document.getElementById('bridge-url-input');

// ── Init ───────────────────────────────────────────────────────────────────

document.getElementById('plugin-version').textContent = PLUGIN_VERSION;
console.log('[Claude AI Plugin] Loaded', PLUGIN_VERSION);

// ── Version bar (top of UI, always visible) ────────────────────────────────
var _vbText   = document.getElementById('versionBarText');
var _vbWarn   = document.getElementById('versionBarBridgeWarn');

function versionBarSetText(bridgeVer) {
  if (_vbText) _vbText.textContent = PLUGIN_VERSION + ' · Bridge ' + (bridgeVer || '...');
}
versionBarSetText(); // initial — bridge version filled in when health check returns

// Plugin update is surfaced via a single notification: the #pluginUpdateBanner
// (see showPluginUpdateBanner). The old version-bar update indicator was removed
// to avoid showing two notifications for the same update.

loadSettings();
checkBridge();
refreshTimeline();
registerTimelineEvents();        // primary: event-driven
setInterval(checkBridge, 15000); // health check every 15s
setInterval(pollTimeline, 5000); // fallback poll every 5s (skips if unchanged)
setTimeout(checkPluginUpdate, 6000);  // first check at 6s (bridge may take time to start)
setTimeout(checkPluginUpdate, 30000); // retry at 30s in case bridge wasn't ready
setInterval(checkPluginUpdate, 5 * 60 * 1000); // auto re-check every 5 min — banner appears without reload

// ── Bridge health ──────────────────────────────────────────────────────────

var REQUIRED_BRIDGE = '1.5.2'; // Plugin v4.2.3+ requires bridge ≥1.5.2

// Compare semver strings: returns -1/0/1
function compareVersions(a, b) {
  var pa = (a || '0').split('.').map(Number);
  var pb = (b || '0').split('.').map(Number);
  for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
    var diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}
var bridgeHealth = null;

function checkBridge() {
  setStatus('connecting', 'Connecting to bridge...');
  var xhr = new XMLHttpRequest();
  xhr.timeout = 4000;
  xhr.open('GET', BRIDGE_URL + '/health', true);
  xhr.onload = function() {
    if (xhr.status === 200) {
      try {
        bridgeHealth = JSON.parse(xhr.responseText);
        var bVer = bridgeHealth.version || '?';

        // Update version bar
        versionBarSetText(bVer);

        // Check if bridge is too old for this plugin
        var caps = bridgeHealth.capabilities || {};
        var bridgeTooOld = !caps.multimodal || compareVersions(bVer, REQUIRED_BRIDGE) < 0;
        if (_vbWarn) _vbWarn.style.display = bridgeTooOld ? '' : 'none';

        if (bridgeTooOld) {
          setStatus('warn', 'Bridge v' + bVer + ' too old — update Bridge app (need ≥' + REQUIRED_BRIDGE + ')');
          return;
        }
        setStatus('connected', 'Bridge v' + bVer +
          ' · ' + (bridgeHealth.mode === 'api-key' ? 'API' : 'CLI'));
      } catch(e) {
        setStatus('connected', 'Bridge connected');
      }
    } else {
      setStatus('offline', 'Bridge error: ' + xhr.status);
    }
  };
  xhr.onerror   = function() { setStatus('offline', 'Bridge offline — run start.command'); };
  xhr.ontimeout = function() { setStatus('offline', 'Bridge timeout — is it running?'); };
  xhr.send();
}

function setStatus(state, text) {
  statusDot.className = state === 'connected' ? 'connected'
                      : state === 'connecting' ? 'connecting'
                      : state === 'warn' ? 'warn'
                      : '';
  statusText.textContent = text;
}

// ── Plugin auto-update ─────────────────────────────────────────────────────

var _pluginUpdateDismissed = false;

function checkPluginUpdate() {
  var current = PLUGIN_VERSION.replace(/^v/, '');
  console.log('[Update] Checking — current:', current);
  var xhr = new XMLHttpRequest();
  xhr.timeout = 20000; // 20s — bridge fetches Gist externally, may be slow
  xhr.open('POST', BRIDGE_URL + '/plugin/check-update', true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onload = function() {
    try {
      var data = JSON.parse(xhr.responseText);
      console.log('[Update] Response:', JSON.stringify(data));
      if (data.ok && data.hasUpdate) {
        console.log('[Update] New version available:', data.latestVersion);
        // Don't re-pop the banner if the user already dismissed it this session.
        if (!_pluginUpdateDismissed) showPluginUpdateBanner(data.latestVersion, data.downloadUrl);
      } else {
        console.log('[Update] Up to date or check failed:', data);
      }
    } catch(e) { console.warn('[Update] Parse error:', e.message, xhr.responseText); }
  };
  xhr.onerror   = function() { console.warn('[Update] Network error'); };
  xhr.ontimeout = function() { console.warn('[Update] Timeout after 20s'); };
  xhr.send(JSON.stringify({ currentVersion: current }));
}

function showPluginUpdateBanner(latestVersion, downloadUrl) {
  var banner  = document.getElementById('pluginUpdateBanner');
  var msg     = document.getElementById('pluginUpdateMsg');
  var updateBtn = document.getElementById('pluginUpdateBtn');
  var dismissBtn = document.getElementById('pluginUpdateDismiss');
  if (!banner || !msg) return;

  msg.textContent = 'Plugin v' + latestVersion + ' available';
  banner.hidden = false;

  updateBtn.onclick = function() {
    updateBtn.disabled = true;
    updateBtn.textContent = 'Downloading…';
    msg.textContent = 'Downloading Plugin v' + latestVersion + '…';
    var xhr2 = new XMLHttpRequest();
    xhr2.timeout = 60000;
    xhr2.open('POST', BRIDGE_URL + '/plugin/update', true);
    xhr2.setRequestHeader('Content-Type', 'application/json');
    xhr2.onload = function() {
      try {
        var data = JSON.parse(xhr2.responseText);
        if (data.ok) {
          msg.textContent = 'Creative Cloud đang mở — click Install, sau đó Reload plugin trong Premiere';
          updateBtn.hidden = true;
        } else {
          msg.textContent = '✗ ' + (data.error || 'Update failed');
          updateBtn.disabled = false;
          updateBtn.textContent = 'Retry';
        }
      } catch(e) {}
    };
    xhr2.onerror = function() {
      msg.textContent = '✗ Bridge offline';
      updateBtn.disabled = false;
      updateBtn.textContent = 'Retry';
    };
    xhr2.send(JSON.stringify({ downloadUrl: downloadUrl, version: latestVersion }));
  };

  dismissBtn.onclick = function() {
    banner.hidden = true;
    _pluginUpdateDismissed = true;
  };
}

// ── Timeline context ───────────────────────────────────────────────────────

var _lastSeqFingerprint = null;

// A cheap fingerprint of the sequence: name + track counts + clip count.
// Changes here trigger a full refresh (so editor adding a clip is detected).
async function getSeqFingerprint() {
  try {
    var seq = await getActiveSequence();
    if (!seq) return null;
    var vc = await seq.getVideoTrackCount();
    var ac = await seq.getAudioTrackCount();
    var clipCount = 0;
    for (var i = 0; i < vc; i++) {
      var t = await seq.getVideoTrack(i);
      var items = await getClipItems(t);
      clipCount += items.length;
    }
    for (var j = 0; j < ac; j++) {
      var ta = await seq.getAudioTrack(j);
      var itemsa = await getClipItems(ta);
      clipCount += itemsa.length;
    }
    return seq.name + '|v' + vc + '|a' + ac + '|c' + clipCount;
  } catch(e) {
    return null;
  }
}

async function pollTimeline() {
  var fp = await getSeqFingerprint();
  if (fp !== _lastSeqFingerprint) {
    _lastSeqFingerprint = fp;
    if (window.__subtextSync) { try { window.__subtextSync(); } catch(e) {} }
    if (fp === null) {
      timelineContext = null;
      timelineInfo.textContent = 'No active sequence';
      contextPanel.classList.remove('visible');
    } else {
      await refreshTimeline();
    }
  }
}

async function refreshTimeline() {
  var result = await ppGetTimelineInfo();
  if (result.ok) {
    timelineContext = result.data;
    var d = result.data;
    timelineInfo.textContent = d.sequenceName + ' · ' + d.clips.length + ' clips';
    contextPanel.classList.add('visible');
    var shapeInfo = d._apiShape
      ? ' <span style="color:#555;font-size:10px;">[track:' + (d._apiShape.trackCountProp||'?') +
        ' clip:' + (d._apiShape.clipCountProp||'?') + ']</span>'
      : '';
    contextContent.innerHTML =
      '<div class="ctx-row">' +
        '<span><span class="ctx-label">Sequence:</span> ' + esc(d.sequenceName) + '</span>' +
        '<span><span class="ctx-label">Duration:</span> ' + d.durationSec.toFixed(1) + 's</span>' +
        '<span><span class="ctx-label">Video:</span> ' + d.videoTrackCount + ' tracks</span>' +
        '<span><span class="ctx-label">Audio:</span> ' + d.audioTrackCount + ' tracks</span>' +
        '<span><span class="ctx-label">Clips:</span> ' + d.clips.length + '</span>' +
        shapeInfo +
      '</div>';
  } else {
    timelineContext = null;
    timelineInfo.textContent = 'No active sequence';
    contextPanel.classList.remove('visible');
  }
}

// ── Send message ───────────────────────────────────────────────────────────

function sendMessage() {
  var content = (msgInput.value == null ? '' : String(msgInput.value)).trim();
  // Allow send if EITHER text OR images present
  if ((!content && attachedImages.length === 0) || isStreaming) return;

  msgInput.value = '';
  autoResize();
  isStreaming = true;
  sendBtn.disabled = true;
  emptyState.style.display = 'none';

  // Build content array (multimodal). If only text, send plain string for backward compat.
  var userMessage;
  if (attachedImages.length > 0) {
    var parts = attachedImages.map(function(img) {
      return { type: 'image', mediaType: img.mediaType, data: img.base64, name: img.name };
    });
    if (content) parts.push({ type: 'text', text: content });
    else         parts.push({ type: 'text', text: 'Parse this cutsheet into a cutlist action.' });
    userMessage = { role: 'user', content: parts };
  } else {
    userMessage = { role: 'user', content: content };
  }

  messages.push(userMessage);
  appendMessageWithAttachments('user', content, attachedImages);

  // Clear attachments after sending (dropzone will hide because messages>0)
  attachedImages = [];
  if (typeof window.refreshDropzoneState === 'function') window.refreshDropzoneState();

  // Detect voice-related messages — inject available voices for auto-pick
  var voiceContext = null;
  if (content && /voice|narrat|speak|script.*gen|gen.*voice|audio.*gen|pick.*voice|choose.*voice/i.test(content)) {
    if (typeof window.VoiceGenGetVoices === 'function') {
      var vList = window.VoiceGenGetVoices().filter(function(v){ return !v.isSep; });
      if (vList.length > 0) {
        voiceContext = vList.map(function(v){ return v.voice_id + ': ' + v.label; }).join('\n');
      }
    }
  }

  var typingEl        = appendTyping();
  var xhr             = new XMLHttpRequest();
  var lastLen         = 0;
  var assistantEl     = null;
  var bubbleEl        = null;
  var fullText        = '';
  var typingRemoved   = false;
  var finished        = false;
  var pendingRateLimit = null; // deferred — only shown if no text follows

  // Lazy helpers so we don't depend on readyState 2 firing
  function removeTyping() {
    if (!typingRemoved) {
      typingRemoved = true;
      if (typingEl.parentNode) typingEl.remove();
    }
  }

  function ensureBubble() {
    if (!assistantEl) {
      assistantEl = appendMessage('assistant', '');
      bubbleEl    = assistantEl.querySelector('.bubble');
    }
  }

  function parseSSE() {
    var text  = xhr.responseText || '';
    var chunk = text.slice(lastLen);
    lastLen   = text.length;
    if (!chunk) return;

    chunk.split('\n').forEach(function(line) {
      if (!line.startsWith('data: ')) return;
      var raw = line.slice(6);
      if (raw === '[DONE]') return;
      try {
        var ev = JSON.parse(raw);
        if (ev.type === 'text') {
          removeTyping();
          ensureBubble();
          fullText += ev.content;
          bubbleEl.innerHTML = renderMd(fullText);
          chatArea.scrollTop = chatArea.scrollHeight;
        } else if (ev.type === 'tool_use') {
          // Show "calling tool: Read" so user knows CLI is working
          ensureBubble();
          var toolNote = '<div style="color:#888;font-style:italic;font-size:11px;">⚙ ' +
                         esc('Claude calling tool: ' + (ev.name || 'unknown')) + '</div>';
          if (!fullText) bubbleEl.innerHTML = toolNote;
        } else if (ev.type === 'heartbeat') {
          // heartbeat — typing indicator still visible; no tooltip in UXP
        } else if (ev.type === 'rate_limit') {
          // Defer rendering — Claude Code CLI often auto-retries and succeeds.
          // Only render the bubble in finishStreaming if no text came after this.
          var resetAt = ev.resetAt || null;
          if (resetAt) RATE_LIMIT_UNTIL = resetAt;
          pendingRateLimit = { resetAt: resetAt, source: ev.source, raw: ev.raw };
        } else if (ev.type === 'error') {
          removeTyping();
          ensureBubble();
          bubbleEl.innerHTML = '<span style="color:var(--error)">' + esc(ev.content) + '</span>';
        } else if (ev.type === 'done') {
          removeTyping();
        }
      } catch(e) { /* skip */ }
    });
  }

  xhr.open('POST', BRIDGE_URL + '/chat', true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.responseType = 'text';

  xhr.onreadystatechange = function() {
    // Parse any new SSE data on every progress event
    if (xhr.readyState === 3 || xhr.readyState === 4) {
      parseSSE();
    }

    if (xhr.readyState === 4 && !finished) {
      finished = true;
      removeTyping();

      if (assistantEl) {
        finishStreaming(fullText, assistantEl, pendingRateLimit); // async, fire-and-forget ok
      } else if (pendingRateLimit) {
        // Rate-limit fired but no text was streamed at all
        var rlMsg = appendMessage('assistant', '');
        var rlBubble = rlMsg ? (rlMsg.querySelector('.bubble') || rlMsg) : null;
        if (rlBubble) renderRateLimitBubble(rlBubble, pendingRateLimit.resetAt, pendingRateLimit.source, pendingRateLimit.raw);
        resetInput();
      } else {
        // Got a response but no text events — check status
        var statusMsg = xhr.status === 0
          ? '❌ Không kết nối được bridge.\n\nMở Terminal và chạy:\n  cd /Users/crossian/premiere-claude-plugin/bridge\n  node server.js'
          : '❌ Bridge trả về lỗi HTTP ' + xhr.status;
        appendMessage('assistant', statusMsg);
        resetInput();
      }
    }
  };

  xhr.onerror = function() {
    if (finished) return;
    finished = true;
    removeTyping();
    appendMessage('assistant', '❌ Không kết nối được bridge.\n\nMở Terminal và chạy:\n  cd /Users/crossian/premiere-claude-plugin/bridge\n  node server.js');
    resetInput();
  };

  xhr.ontimeout = function() {
    if (finished) return;
    finished = true;
    removeTyping();
    appendMessage('assistant', '❌ Request timeout — bridge quá chậm hoặc không phản hồi.');
    resetInput();
  };

  xhr.timeout = 300000; // 5 min — CLI image parsing can be slow
  xhr.send(JSON.stringify({
    messages:        messages,
    timelineContext: timelineContext,
    model:           CLAUDE_MODEL,
    apiKey:          ANTHROPIC_KEY || undefined,
    voiceContext:    voiceContext || undefined,
  }));
}

async function finishStreaming(fullText, assistantEl, pendingRateLimit) {
  messages.push({ role: 'assistant', content: fullText });

  // Only show rate-limit bubble if no text was received (CLI didn't auto-recover)
  if (pendingRateLimit && !fullText) {
    var bEl = assistantEl ? (assistantEl.querySelector('.bubble') || assistantEl) : null;
    if (bEl) renderRateLimitBubble(bEl, pendingRateLimit.resetAt, pendingRateLimit.source, pendingRateLimit.raw);
  }

  var actions = parseActions(fullText);
  if (actions.length > 0) {
    await executeActions(actions, assistantEl);
    refreshTimeline(); // async, fire-and-forget
  }
  resetInput();
}

function resetInput() {
  isStreaming      = false;
  sendBtn.disabled = false;
  msgInput.focus();
}

// ── Parse ```actions blocks ────────────────────────────────────────────────

function parseActions(text) {
  var results = [];
  var re = /```actions\s*([\s\S]*?)```/g;
  var m;
  while ((m = re.exec(text)) !== null) {
    try {
      var parsed = JSON.parse(m[1].trim());
      results = results.concat(Array.isArray(parsed) ? parsed : [parsed]);
    } catch(e) { /* skip */ }
  }
  return results;
}

async function executeActions(actions, parentEl) {
  var bubbleEl = parentEl.querySelector('.bubble') || parentEl;

  var divider = document.createElement('div');
  divider.style.cssText = 'border-top:1px solid #2d4a2d;margin-top:8px;padding-top:8px;';
  bubbleEl.appendChild(divider);

  for (var i = 0; i < actions.length; i++) {
    var action = actions[i];
    var chip   = document.createElement('div');
    chip.className   = 'action-result';
    chip.textContent = '⚙ ' + action.action + '…';
    bubbleEl.appendChild(chip);

    var result = await ppExecuteAction(action);   // ← await async API
    if (result.ok) {
      chip.textContent = '✓ ' + (result.data.message || action.action);
    } else {
      chip.className   = 'action-result error';
      chip.textContent = '✗ ' + action.action + ': ' + result.error;
    }
    chatArea.scrollTop = chatArea.scrollHeight;
  }
}

// ── DOM helpers ────────────────────────────────────────────────────────────

function appendMessage(role, content) {
  return appendMessageWithAttachments(role, content, []);
}

function appendMessageWithAttachments(role, content, attachments) {
  var wrapper  = document.createElement('div');
  wrapper.className = 'message ' + role;

  var roleEl = document.createElement('span');
  roleEl.className = 'role';
  roleEl.textContent = role === 'user' ? 'You' : 'Claude';

  var bubbleEl = document.createElement('div');
  bubbleEl.className = 'bubble';

  // Render attached images first
  if (attachments && attachments.length > 0) {
    var attachWrap = document.createElement('div');
    attachWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;';
    attachments.forEach(function(att) {
      var thumb = document.createElement('img');
      thumb.src = att.dataUrl;
      thumb.alt = att.name || 'image';

      thumb.style.cssText = 'max-width:200px;max-height:200px;border-radius:6px;border:1px solid var(--border);cursor:pointer;';
      thumb.onclick = function() {
        // Toggle full-size view
        if (thumb.style.maxWidth === '100%') {
          thumb.style.maxWidth = '200px';
          thumb.style.maxHeight = '200px';
        } else {
          thumb.style.maxWidth = '100%';
          thumb.style.maxHeight = 'none';
        }
      };
      attachWrap.appendChild(thumb);
    });
    bubbleEl.appendChild(attachWrap);
  }

  var textEl = document.createElement('div');
  textEl.innerHTML = renderMd(content || '');
  bubbleEl.appendChild(textEl);

  wrapper.appendChild(roleEl);
  wrapper.appendChild(bubbleEl);
  chatArea.appendChild(wrapper);
  chatArea.scrollTop = chatArea.scrollHeight;
  return wrapper;
}

function appendTyping() {
  var wrapper  = document.createElement('div');
  wrapper.className = 'message assistant';

  var roleEl = document.createElement('span');
  roleEl.className = 'role';
  roleEl.textContent = 'Claude';

  var indic = document.createElement('div');
  indic.className = 'typing-indicator';
  for (var i = 0; i < 3; i++) {
    var dot = document.createElement('span');
    indic.appendChild(dot);
  }

  wrapper.appendChild(roleEl);
  wrapper.appendChild(indic);
  chatArea.appendChild(wrapper);
  chatArea.scrollTop = chatArea.scrollHeight;
  return wrapper;
}

// Minimal markdown: code blocks, inline code, bold, newlines
// Hides ```actions blocks from the chat display
function renderMd(text) {
  return esc(text)
    .replace(/```actions[\s\S]*?```/g, '')
    .replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

function esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── UXP keyboard focus helper ──────────────────────────────────────────────
// While a textarea has focus, Premiere Pro's keyboard shortcuts (e.g. B→Brush, V→Move)
// would fire if we don't claim keyboard focus. setKeyboardFocus(true) prevents that.
(function() {
  var _uxpHost = null;
  try { var _u = window.require && window.require('uxp'); if (_u && _u.host) _uxpHost = _u.host; } catch(e) {}

  window.claimKeyboard = function() {
    if (_uxpHost && typeof _uxpHost.setKeyboardFocus === 'function') {
      try { _uxpHost.setKeyboardFocus(true); } catch(e) {}
    }
  };
  window.releaseKeyboard = function() {
    if (_uxpHost && typeof _uxpHost.setKeyboardFocus === 'function') {
      try { _uxpHost.setKeyboardFocus(false); } catch(e) {}
    }
  };
})();


// Wire keyboard focus for every text input/textarea in the Claude tab
// Wire all text inputs in the settings panel and Claude tab
(function() {
  var inputs = document.querySelectorAll(
    '#bridge-url-input, #api-key-input, #model-select'
  );
  inputs.forEach(function(el) {
    el.addEventListener('focus', window.claimKeyboard);
    el.addEventListener('blur',  window.releaseKeyboard);
  });
})();

// ── Auto-resize textarea ───────────────────────────────────────────────────

function autoResize() {
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 180) + 'px';
}

// VoiceGen textarea auto-resize: set height to '1px' first so the browser is forced
// to reflow and report the true content height via scrollHeight, then lock that in.
// Sizer div drives wrapper height — no scrollHeight tricks needed (UXP-safe).
function vgAutoResize(el) {
  var sizer = el.parentNode && el.parentNode.querySelector('.vg-scriptSizer');
  if (!sizer) return;
  sizer.textContent = (el.value || '') + '\n';
}

msgInput.addEventListener('input', autoResize);
msgInput.addEventListener('focus', window.claimKeyboard);
msgInput.addEventListener('blur',  window.releaseKeyboard);
msgInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
sendBtn.addEventListener('click', sendMessage);

// ── Quick action buttons + Custom shortcuts ────────────────────────────────

// Built-in "Parse cutsheet" button
document.querySelectorAll('.quick-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    msgInput.value = btn.dataset.prompt;
    autoResize();
    msgInput.focus();
  });
});

// Custom shortcuts — stored in localStorage as [{name, prompt}]
function loadShortcuts() {
  try { return JSON.parse(localStorage.getItem('claude-shortcuts') || '[]'); } catch(e) { return []; }
}
function saveShortcuts(arr) {
  try { localStorage.setItem('claude-shortcuts', JSON.stringify(arr)); } catch(e) {}
}

function renderShortcuts() {
  var container = document.getElementById('quick-actions');
  var addBtn    = document.getElementById('add-shortcut-btn');
  if (!container || !addBtn) return;
  // Remove any previously rendered custom buttons (class = custom-shortcut-btn)
  container.querySelectorAll('.custom-shortcut-btn').forEach(function(el) { el.remove(); });
  var shortcuts = loadShortcuts();
  shortcuts.forEach(function(sc, idx) {
    var btn = document.createElement('button');
    btn.className = 'quick-btn custom-shortcut-btn';
    btn.textContent = sc.name || ('Shortcut ' + (idx + 1));
    btn.dataset.promptFull = sc.prompt; // stored for reference, no title (UXP tooltip renders wrong)
    btn.dataset.prompt = sc.prompt;
    btn.addEventListener('click', function() {
      msgInput.value = sc.prompt;
      autoResize();
      msgInput.focus();
    });
    // Long-press / right-click to delete
    btn.addEventListener('contextmenu', function(e) {
      e.preventDefault();
      if (confirm('Delete shortcut "' + sc.name + '"?')) {
        var arr = loadShortcuts();
        arr.splice(idx, 1);
        saveShortcuts(arr);
        renderShortcuts();
      }
    });
    container.insertBefore(btn, addBtn);
  });
}

var _scPopup = null;
function closeShortcutPopup() {
  if (_scPopup && _scPopup.parentNode) _scPopup.parentNode.removeChild(_scPopup);
  _scPopup = null;
  document.removeEventListener('click', _scOutsideHandler, true);
  // Restore the textarea row
  var inputRow = document.getElementById('input-row');
  if (inputRow) inputRow.style.display = '';
}
function _scOutsideHandler(e) {
  if (_scPopup && !_scPopup.contains(e.target) && e.target.id !== 'add-shortcut-btn') {
    closeShortcutPopup();
  }
}
function showAddShortcutPopup() {
  if (_scPopup) { closeShortcutPopup(); return; }
  var triggerBtn  = document.getElementById('add-shortcut-btn');
  var quickActions = document.getElementById('quick-actions');
  var inputRow    = document.getElementById('input-row');

  // ── Hide the main textarea while popup is open ─────────────────────────
  // Native <textarea> in UXP/Chromium renders in a higher compositor layer
  // and always paints above any absolutely-positioned element.
  // Hiding #input-row eliminates the overlap completely.
  if (inputRow) inputRow.style.display = 'none';

  var popup = document.createElement('div');
  popup.className = 'shortcut-popup';
  _scPopup = popup;

  popup.innerHTML =
    '<div class="sp-title">New shortcut</div>' +
    '<input class="sp-name" placeholder="Button label…" maxlength="24">' +
    '<textarea class="sp-prompt" placeholder="Prompt text…" rows="3"></textarea>' +
    '<div class="sp-actions">' +
      '<button class="sp-cancel">Cancel</button>' +
      '<button class="sp-save">Save</button>' +
    '</div>';

  // Append to #tab-claude (position:relative, overflow:visible) so the popup
  // isn't clipped by #claude-content (overflow:hidden).
  var container = document.getElementById('tab-claude') || document.body;
  container.appendChild(popup);

  // ── Position: left-aligned, bottom just above #quick-actions ──────────
  // Measure after appending so the browser knows the popup dimensions.
  var contRect = container.getBoundingClientRect();
  var pw       = Math.min(220, (contRect.width || 240) - 16);
  popup.style.width = pw + 'px';

  // Horizontal: 8 px from panel left edge
  popup.style.left = '8px';

  // Vertical: anchor popup bottom to quick-actions top, 8 px gap
  var anchor = quickActions || triggerBtn;
  if (anchor) {
    var anchorRect  = anchor.getBoundingClientRect();
    var anchorTopRel = anchorRect.top - contRect.top; // relative to #tab-claude
    var popH = popup.offsetHeight || 178;
    var top  = anchorTopRel - popH - 8;
    if (top < 4) top = 4;
    popup.style.top = top + 'px';
  }

  popup.querySelector('.sp-cancel').addEventListener('click', function(e) {
    e.stopPropagation(); closeShortcutPopup();
  });
  popup.querySelector('.sp-save').addEventListener('click', function(e) {
    e.stopPropagation();
    var name   = popup.querySelector('.sp-name').value.trim();
    var prompt = popup.querySelector('.sp-prompt').value.trim();
    if (!name || !prompt) { alert('Name and prompt are required.'); return; }
    var arr = loadShortcuts();
    arr.push({ name: name, prompt: prompt });
    saveShortcuts(arr);
    renderShortcuts();
    closeShortcutPopup();
  });

  setTimeout(function() {
    document.addEventListener('click', _scOutsideHandler, true);
    try { popup.querySelector('.sp-name').focus(); } catch(e) {}
  }, 20);
}

document.getElementById('add-shortcut-btn').addEventListener('click', function(e) {
  e.stopPropagation();
  showAddShortcutPopup();
});

// Initial render
renderShortcuts();

// ── Clear chat ─────────────────────────────────────────────────────────────

document.getElementById('clear-btn').addEventListener('click', function() {
  messages = [];
  attachedImages = [];
  chatArea.innerHTML = '';
  emptyState.style.display = '';
  chatArea.appendChild(emptyState);
  if (typeof window.refreshDropzoneState === 'function') window.refreshDropzoneState();
});

// ── Refresh button ─────────────────────────────────────────────────────────

document.getElementById('refresh-btn').addEventListener('click', function() {
  console.log('[Plugin] Manual refresh triggered');
  _lastSeqFingerprint = null; // invalidate cache, force full re-scan
  refreshTimeline();
  checkBridge();
});

// ── Settings ───────────────────────────────────────────────────────────────

var modelSelect = document.getElementById('model-select');
var apiKeyInput = document.getElementById('api-key-input');
var apiKeyStatus = document.getElementById('apikey-status');

// Autocut "gen voice on Validate" behaviour picker — persists to its own key so it
// survives reloads/new cuts (independent of the main Save button).
(function () {
  var sel = document.getElementById('sacGenVoiceMode');
  if (!sel) return;
  var v = localStorage.getItem('sac_genvoice_mode');
  sel.value = (v === 'auto' || v === 'never') ? v : 'ask';
  sel.addEventListener('change', function () {
    localStorage.setItem('sac_genvoice_mode', sel.value);
  });
})();
// ElevenLabs key is now managed in the Voice Gen tab settings panel, not here.
var elKeyInput = null; // removed from Claude Settings panel
var elStatus   = null;

// UXP localStorage CAN persist across plugin reloads but is sometimes wiped
// when the plugin is reloaded via UXP Developer Tool (vs. just panel close).
// We also persist to UXP's local data folder as a backup.
async function persistSettingsToFile(obj) {
  try {
    var uxp = window.require && window.require('uxp');
    if (!uxp || !uxp.storage) return;
    var lfs = uxp.storage.localFileSystem;
    var dataFolder = await lfs.getDataFolder();
    var file = await dataFolder.createFile('settings.json', { overwrite: true });
    await file.write(JSON.stringify(obj));
    console.log('[Settings] persisted to UXP data folder:', dataFolder.nativePath);
  } catch(e) { console.warn('[Settings] file persist failed:', e.message); }
}

async function loadSettingsFromFile() {
  try {
    var uxp = window.require && window.require('uxp');
    if (!uxp || !uxp.storage) return null;
    var lfs = uxp.storage.localFileSystem;
    var dataFolder = await lfs.getDataFolder();
    var entries = await dataFolder.getEntries();
    var file = entries.find(function(e) { return e.name === 'settings.json'; });
    if (!file) return null;
    var text = await file.read();
    return JSON.parse(text);
  } catch(e) { console.warn('[Settings] file load failed:', e.message); return null; }
}

function applySettings(s) {
  if (!s) return;
  if (s.bridgeUrl)     BRIDGE_URL    = s.bridgeUrl;
  if (s.claudeModel)   CLAUDE_MODEL  = s.claudeModel;
  if (s.anthropicKey)  ANTHROPIC_KEY = s.anthropicKey;
  if (s.geminiKey)     GEMINI_KEY    = s.geminiKey;
  if (s.elevenlabsKey) ELEVENLABS_KEY = s.elevenlabsKey;
  // Load profiles; migrate legacy single-key to a Default profile
  if (Array.isArray(s.elevenlabsProfiles) && s.elevenlabsProfiles.length) {
    EL_PROFILES = s.elevenlabsProfiles;
    EL_ACTIVE_PROFILE_ID = s.elevenlabsActiveProfileId || EL_PROFILES[0].id;
    var active = EL_PROFILES.find(function(p) { return p.id === EL_ACTIVE_PROFILE_ID; });
    if (active) ELEVENLABS_KEY = active.key;
  } else if (s.elevenlabsKey && !EL_PROFILES.length) {
    var defId = 'p_default';
    EL_PROFILES = [{ id: defId, name: 'Default', key: s.elevenlabsKey }];
    EL_ACTIVE_PROFILE_ID = defId;
  }
  // Always guarantee at least one profile (uses the built-in default key).
  if (!EL_PROFILES.length) {
    EL_PROFILES = [{ id: 'p_default', name: 'Default', key: ELEVENLABS_KEY }];
    EL_ACTIVE_PROFILE_ID = 'p_default';
  }
  if (bridgeUrlInput) bridgeUrlInput.value = BRIDGE_URL;
  if (modelSelect)    modelSelect.value = CLAUDE_MODEL;
  if (apiKeyInput)    apiKeyInput.value = ANTHROPIC_KEY;
  var gemInput = document.getElementById('gemini-key-input');
  if (gemInput)       gemInput.value = GEMINI_KEY;
  if (elKeyInput)     elKeyInput.value  = ELEVENLABS_KEY;
  updateApiKeyStatus();
  updateElStatus();
}

function loadSettings() {
  // First try localStorage (sync, fast)
  try {
    var s = JSON.parse(localStorage.getItem('claude-plugin-settings') || '{}');
    applySettings(s);
    console.log('[Settings] loaded from localStorage — el-key len:', (ELEVENLABS_KEY||'').length);
  } catch(e) { console.warn('[Settings] localStorage load failed:', e.message); }

  // Then try UXP data folder (async, fallback for fresh localStorage)
  loadSettingsFromFile().then(function(fileSettings) {
    if (fileSettings) {
      // Only apply file settings if they have more data than what we already have
      var hasNew = false;
      if (fileSettings.elevenlabsKey && !ELEVENLABS_KEY) { ELEVENLABS_KEY = fileSettings.elevenlabsKey; hasNew = true; }
      if (fileSettings.anthropicKey  && !ANTHROPIC_KEY)  { ANTHROPIC_KEY  = fileSettings.anthropicKey;  hasNew = true; }
      if (Array.isArray(fileSettings.elevenlabsProfiles) && fileSettings.elevenlabsProfiles.length && !EL_PROFILES.length) {
        EL_PROFILES = fileSettings.elevenlabsProfiles;
        EL_ACTIVE_PROFILE_ID = fileSettings.elevenlabsActiveProfileId || EL_PROFILES[0].id;
        var fp = EL_PROFILES.find(function(p) { return p.id === EL_ACTIVE_PROFILE_ID; });
        if (fp) ELEVENLABS_KEY = fp.key;
        hasNew = true;
      }
      if (hasNew) {
        if (elKeyInput)  elKeyInput.value  = ELEVENLABS_KEY;
        if (apiKeyInput) apiKeyInput.value = ANTHROPIC_KEY;
        updateApiKeyStatus();
        updateElStatus();
        console.log('[Settings] hydrated from file backup');
        if (typeof window.VoiceGenOnKeyChange === 'function') window.VoiceGenOnKeyChange();
      }
    }
  });
}

function updateElStatus() {
  if (!elStatus) return;
  if (ELEVENLABS_KEY) {
    // Show preview: first 4 + last 4 chars (e.g. "sk_5...574f")
    var k = ELEVENLABS_KEY;
    var preview = k.length > 12 ? (k.slice(0, 5) + '…' + k.slice(-4)) : 'ready';
    elStatus.textContent = preview;
    elStatus.classList.add('is-api');
  } else {
    elStatus.textContent = 'not set';
    elStatus.classList.remove('is-api');
  }
}
function updateApiKeyStatus() {
  if (!apiKeyStatus) return;
  if (ANTHROPIC_KEY) {
    var k = ANTHROPIC_KEY;
    var preview = k.length > 12 ? (k.slice(0, 7) + '…' + k.slice(-4)) : 'ready';
    apiKeyStatus.textContent = 'API · ' + preview;
    apiKeyStatus.classList.add('is-api');
  } else {
    apiKeyStatus.textContent = 'CLI mode';
    apiKeyStatus.classList.remove('is-api');
  }
}

function populateBridgeInfo() {
  var statusEl  = document.getElementById('bridge-info-status');
  var modeEl    = document.getElementById('bridge-info-mode');
  var whisperEl = document.getElementById('bridge-info-whisper');
  if (!statusEl) return;

  statusEl.textContent  = 'Checking…';
  modeEl.textContent    = '—';
  whisperEl.textContent = '—';

  var xhr = new XMLHttpRequest();
  xhr.open('GET', BRIDGE_URL + '/health', true);
  xhr.timeout = 4000;
  xhr.onload = function() {
    try {
      var d = JSON.parse(xhr.responseText);
      statusEl.innerHTML = '<span class="ok">connected</span> v' + (d.version || '?');
      modeEl.textContent = d.mode === 'api-key'
        ? 'API key (Anthropic SDK)'
        : 'CLI OAuth (Claude Code)';
      if (d.whisper) {
        whisperEl.innerHTML = (d.whisper.ok
          ? '<span class="ok">found</span>'
          : '<span class="fail">missing</span>') +
          ' · model=' + d.whisper.model + ' · lang=' + d.whisper.lang;
      }
    } catch(e) {
      statusEl.innerHTML = '<span class="fail">parse error</span>';
    }
  };
  xhr.onerror   = function() { statusEl.innerHTML = '<span class="fail">offline</span>'; };
  xhr.ontimeout = function() { statusEl.innerHTML = '<span class="fail">timeout</span>'; };
  xhr.send();
}

// Settings is a global overlay (reparented to <body>), opened from the ⚙ in the
// version bar. It sits just below the version bar and covers the active tab.
// Switch the settings modal between its General / Voice Gen tabs.
function setSettingsTab(which) {
  document.querySelectorAll('.settings-tab').forEach(function(t) {
    t.classList.toggle('is-active', t.getAttribute('data-stab') === which);
  });
  document.querySelectorAll('.settings-tabPanel').forEach(function(p) {
    p.hidden = (p.getAttribute('data-stab') !== which);
  });
}

function openSettingsPanel(tab) {
  var vb    = document.getElementById('versionBar');
  var topPx = vb ? (vb.offsetTop + vb.offsetHeight + 2) : 4;
  settingsModal.style.top = topPx + 'px';
  settingsModal.style.display = 'block';
  // UXP renders native <textarea>/<input>/<select> above everything, so the active
  // tab's fields would bleed over the overlay — hide all tab panels while open.
  document.querySelectorAll('.tab-panel').forEach(function(p) { p.style.display = 'none'; });
  setSettingsTab(tab || 'general');
  populateBridgeInfo();
  var spv = document.getElementById('settings-plugin-version');
  if (spv) spv.textContent = PLUGIN_VERSION;
}
function closeSettingsPanel() {
  settingsModal.style.display = 'none';
  // Clear the inline display so the .tab-panel.active CSS rule shows the right tab again.
  document.querySelectorAll('.tab-panel').forEach(function(p) { p.style.display = ''; });
}

document.getElementById('settings-btn').addEventListener('click', function(e) {
  e.stopPropagation();
  if (settingsModal.style.display === 'block') closeSettingsPanel();
  else openSettingsPanel('general');
});
document.getElementById('close-settings').addEventListener('click', closeSettingsPanel);

// Settings tab bar (General / Voice Gen)
document.querySelectorAll('.settings-tab').forEach(function(t) {
  t.addEventListener('click', function() { setSettingsTab(t.getAttribute('data-stab')); });
});

// Click outside to close (check via DOM containment)
document.addEventListener('click', function(e) {
  if (settingsModal.style.display !== 'block') return;
  if (settingsModal.contains(e.target)) return;
  var btn = document.getElementById('settings-btn');
  if (btn && btn.contains(e.target)) return;
  closeSettingsPanel();
});
document.getElementById('save-settings').addEventListener('click', function() {
  // Defensive: in UXP webview, input.value can be null for empty password fields
  function readInput(el) {
    if (!el) return '';
    var v = el.value;
    if (v == null) return '';
    return String(v).trim();
  }
  console.log('[Settings] Save clicked. el-key-input element:', !!elKeyInput,
              '| value type:', elKeyInput ? typeof elKeyInput.value : 'N/A');
  BRIDGE_URL     = readInput(bridgeUrlInput) || 'http://localhost:3030';
  CLAUDE_MODEL   = (modelSelect && modelSelect.value) || CLAUDE_MODEL;
  ANTHROPIC_KEY  = readInput(apiKeyInput);
  GEMINI_KEY     = readInput(document.getElementById('gemini-key-input'));
  // ElevenLabs key is managed in the Voice Gen settings tab — don't overwrite it here
  console.log('[Settings] saved — anthropic:', ANTHROPIC_KEY.length, 'chars | gemini:', GEMINI_KEY.length, 'chars');
  var settingsObj = {
    bridgeUrl:                  BRIDGE_URL,
    claudeModel:                CLAUDE_MODEL,
    anthropicKey:               ANTHROPIC_KEY,
    geminiKey:                  GEMINI_KEY,
    elevenlabsKey:              ELEVENLABS_KEY,
    elevenlabsProfiles:         EL_PROFILES,
    elevenlabsActiveProfileId:  EL_ACTIVE_PROFILE_ID,
  };
  localStorage.setItem('claude-plugin-settings', JSON.stringify(settingsObj));
  // Also persist to UXP data folder as backup (survives some localStorage clears)
  persistSettingsToFile(settingsObj);
  updateApiKeyStatus();
  updateElStatus();
  if (ANTHROPIC_KEY) RATE_LIMIT_UNTIL = 0;
  // Vừa điền/xoá key Gemini → cập nhật model mặc định Organize cho khớp (nếu user chưa chọn tay).
  if (typeof window.sacSyncOrganizeModelUI === 'function') window.sacSyncOrganizeModelUI();
  closeSettingsPanel();
  checkBridge();
  // Notify Voice Gen module to refresh
  if (typeof window.VoiceGenOnKeyChange === 'function') window.VoiceGenOnKeyChange();
});

// ═══════════════════════════════════════════════════════════════════════════
// RATE-LIMIT COUNTDOWN BUBBLE
// ═══════════════════════════════════════════════════════════════════════════
function renderRateLimitBubble(bubbleEl, resetAtMs, source, rawEvent) {
  function fmt(s) {
    if (s <= 0) return '0:00';
    var m = Math.floor(s / 60), sec = s % 60;
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }
  var countdownBlock;
  if (resetAtMs) {
    // Real countdown from CLI event
    countdownBlock = '<div class="rl-countdown" id="rl-cd">--:--</div>' +
      '<div style="font-size:10px;color:var(--text-dim);">' +
        '✓ Reset time từ field <code>' + esc(source || 'unknown') + '</code>' +
      '</div>';
  } else {
    // Unknown — be honest, don't fake a countdown
    countdownBlock = '<div class="rl-countdown" style="color:#888;">unknown</div>' +
      '<div style="font-size:10px;color:var(--text-dim);">' +
        'CLI không expose reset time. ' +
        '<a href="#" id="rl-show-raw" style="color:#a855f7;">Show raw event</a>' +
      '</div>';
  }
  bubbleEl.innerHTML =
    '<div class="rate-limit-bubble">' +
      '<div class="rl-title">⚠ Claude subscription bị rate-limited</div>' +
      '<div>Subscription quota tạm hết. ' +
        (resetAtMs ? 'Đợi đến khi reset:' : 'Reset thời gian không xác định.') + '</div>' +
      countdownBlock +
      '<div class="rl-hint">' +
        '<b>Cách khác (không cần đợi):</b><br>' +
        '• Settings <code>⚙</code> → paste <code>ANTHROPIC_API_KEY</code> để dùng API mode<br>' +
        '• Mở tab <b>AUTOCUT</b> → <b>Manual Paste</b> → paste text trực tiếp (3 cột)' +
      '</div>' +
    '</div>';

  if (resetAtMs) {
    function tick() {
      var remain = Math.max(0, Math.ceil((resetAtMs - Date.now()) / 1000));
      var cd = document.getElementById('rl-cd');
      if (cd) cd.textContent = fmt(remain) + (remain > 0 ? '' : ' — ready');
      if (remain <= 0) clearInterval(timerId);
    }
    tick();
    var timerId = setInterval(tick, 1000);
  } else {
    // Show raw event on click — helps user paste exact JSON to me for further fix
    var link = document.getElementById('rl-show-raw');
    if (link && rawEvent) {
      link.addEventListener('click', function(e) {
        e.preventDefault();
        var pre = document.createElement('pre');
        pre.style.cssText = 'background:#111;padding:8px;border-radius:4px;font-size:10px;margin-top:6px;max-height:200px;overflow:auto;color:#888;';
        pre.textContent = JSON.stringify(rawEvent, null, 2);
        link.parentNode.appendChild(pre);
        link.style.display = 'none';
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// IMAGE ATTACH — attach button + drag-drop + clipboard paste
// (New layout: big dropzone replaced by small attach button; chips in #chips-row)
// ═══════════════════════════════════════════════════════════════════════════
(function() {
  var dropzone   = document.getElementById('dropzone');   // hidden, events-only
  var inputArea  = document.getElementById('input-area'); // drag target
  var dzChips    = document.getElementById('dropzone-chips');
  var chipsRow   = document.getElementById('chips-row');
  var attachBtn  = document.getElementById('attach-btn');

  var SUPPORTED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
  var MAX_SIZE_MB = 8;

  // Convert ArrayBuffer to base64 (chunked to avoid call-stack overflow)
  function bufToBase64(buf) {
    var bytes = new Uint8Array(buf);
    var bin = '';
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function inferMediaType(name, fallback) {
    var lower = (name || '').toLowerCase();
    if (lower.endsWith('.png'))  return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.gif'))  return 'image/gif';
    return fallback || 'image/png';
  }

  function fmtSize(n) {
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + 'KB';
    return (n / (1024 * 1024)).toFixed(1) + 'MB';
  }

  // Single-image policy: always replace the existing attachment.
  function addAttachment(att) { addAttachmentSingle(att); }

  // Single attachment policy: replace existing if user picks a new one
  function addAttachmentSingle(att) {
    attachedImages = [att]; // overwrite any previous
    renderAttachBar();
  }

  window.renderAttachBar = function() {
    if (dzChips) dzChips.innerHTML = '';
    var hasChip = attachedImages.length > 0;

    if (hasChip) {
      if (chipsRow) chipsRow.removeAttribute('hidden');
      if (attachBtn) attachBtn.classList.add('has-file');

      var att = attachedImages[0];
      var chip = document.createElement('div');
      chip.className = 'attach-chip';
      chip.innerHTML =
        '<img src="' + att.dataUrl + '" alt="">' +
        '<div class="attach-meta">' +
          '<span class="attach-name" title="' + esc(att.name) + '">' + esc(att.name) + '</span>' +
          '<span class="attach-size">' + fmtSize(att.size || 0) + '</span>' +
        '</div>' +
        '<button class="attach-remove" title="Remove">&times;</button>';
      chip.querySelector('.attach-remove').addEventListener('click', function(e) {
        e.stopPropagation();
        attachedImages = [];
        window.renderAttachBar();
      });
      chip.querySelector('img').addEventListener('click', function(e) {
        e.stopPropagation();
        var img = e.target;
        if (img.style.width === '160px') { img.style.width = '40px'; img.style.height = '40px'; }
        else                              { img.style.width = '160px'; img.style.height = 'auto'; }
      });
      if (dzChips) dzChips.appendChild(chip);
    } else {
      if (chipsRow) chipsRow.setAttribute('hidden', '');
      if (attachBtn) attachBtn.classList.remove('has-file');
    }
  };

  // Expose so other parts of main.js can trigger re-render after messages change
  window.refreshDropzoneState = function() { window.renderAttachBar(); };

  // ── File picker (UXP storage API) ───────────────────────────────────────
  async function pickAndAttachFile() {
    try {
      var uxp = window.require && window.require('uxp');
      if (!uxp || !uxp.storage) {
        alert('UXP storage API not available');
        return;
      }
      var lfs = uxp.storage.localFileSystem;
      var formats = uxp.storage.formats;
      var file = await lfs.getFileForOpening({
        types: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
        allowMultiple: false,
      });
      if (!file) return; // user cancelled

      var buf = await file.read({ format: formats.binary });
      var size = buf.byteLength || buf.length;
      var sizeMB = size / (1024 * 1024);
      if (sizeMB > MAX_SIZE_MB) {
        alert('Image too large (' + sizeMB.toFixed(1) + 'MB). Max ' + MAX_SIZE_MB + 'MB.');
        return;
      }
      var b64 = bufToBase64(buf);
      var mediaType = inferMediaType(file.name);
      addAttachment({
        name: file.name,
        mediaType: mediaType,
        size: size,
        base64: b64,
        dataUrl: 'data:' + mediaType + ';base64,' + b64,
      });
    } catch(e) {
      console.error('[attach] file error:', e);
      alert('Failed to read file: ' + e.message);
    }
  }

  // ── Read File/Blob (from clipboard or drop) ─────────────────────────────
  function attachFromBlob(blob, fallbackName) {
    if (!blob) return;
    var sizeMB = blob.size / (1024 * 1024);
    if (sizeMB > MAX_SIZE_MB) {
      alert('Image too large (' + sizeMB.toFixed(1) + 'MB). Max ' + MAX_SIZE_MB + 'MB.');
      return;
    }
    if (SUPPORTED_TYPES.indexOf(blob.type) < 0) {
      alert('Unsupported image type: ' + blob.type);
      return;
    }
    var reader = new FileReader();
    reader.onload = function(e) {
      var dataUrl = e.target.result; // "data:image/png;base64,..."
      var commaIdx = dataUrl.indexOf(',');
      var b64 = dataUrl.slice(commaIdx + 1);
      addAttachment({
        name: blob.name || fallbackName || ('clipboard-' + Date.now() + '.png'),
        mediaType: blob.type,
        size: blob.size,
        base64: b64,
        dataUrl: dataUrl,
      });
    };
    reader.onerror = function() { alert('Failed to read image'); };
    reader.readAsDataURL(blob);
  }

  // ── Attach button → file picker ──────────────────────────────────────────
  if (attachBtn) {
    attachBtn.addEventListener('click', function() { pickAndAttachFile(); });
  }

  // ── Drag & drop on #input-area ────────────────────────────────────────────
  var dragTarget = inputArea || dropzone;
  ['dragenter', 'dragover'].forEach(function(evt) {
    dragTarget.addEventListener(evt, function(e) {
      e.preventDefault();
      e.stopPropagation();
      dragTarget.classList.add('is-drag-over');
    });
  });
  dragTarget.addEventListener('dragleave', function(e) {
    e.preventDefault();
    e.stopPropagation();
    if (dragTarget.contains(e.relatedTarget)) return;
    dragTarget.classList.remove('is-drag-over');
  });

  // Helper: try to read a file path via UXP storage API
  async function tryLoadByPath(filePath) {
    try {
      var uxp = window.require && window.require('uxp');
      if (!uxp || !uxp.storage) return false;
      var lfs = uxp.storage.localFileSystem;
      var formats = uxp.storage.formats;
      // file:// URL requires exactly three slashes for an absolute path:  file:///path
      var fileUrl = 'file://' + (filePath.startsWith('/') ? '' : '/') + filePath;
      var file = await lfs.getEntryWithUrl
        ? await lfs.getEntryWithUrl(fileUrl)
        : (lfs.getFileForPath ? await lfs.getFileForPath(filePath) : null);
      if (!file || file.isFolder) return false;
      var buf = await file.read({ format: formats.binary });
      var size = buf.byteLength || buf.length;
      var b64 = bufToBase64(buf);
      var mediaType = inferMediaType(file.name);
      addAttachment({
        name: file.name, mediaType: mediaType, size: size,
        base64: b64, dataUrl: 'data:' + mediaType + ';base64,' + b64,
      });
      return true;
    } catch(e) {
      console.warn('[drop] tryLoadByPath failed:', filePath, e.message);
      return false;
    }
  }

  // Helper: fallback — ask bridge to read the file and return base64
  async function tryLoadViaBridge(filePath) {
    try {
      var res = await fetch(BRIDGE_URL + '/api/read-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: filePath }),
      });
      if (!res.ok) return false;
      var data = await res.json();
      if (!data.base64) return false;
      var mediaType = data.mediaType || inferMediaType(filePath);
      var fileName  = filePath.split('/').pop() || 'image.png';
      addAttachment({
        name: fileName, mediaType: mediaType, size: data.size || 0,
        base64: data.base64, dataUrl: 'data:' + mediaType + ';base64,' + data.base64,
      });
      return true;
    } catch(e) {
      console.warn('[drop] tryLoadViaBridge failed:', filePath, e.message);
      return false;
    }
  }

  dragTarget.addEventListener('drop', async function(e) {
    e.preventDefault();
    e.stopPropagation();
    dragTarget.classList.remove('is-drag-over');

    var dt = e.dataTransfer;
    if (!dt) {
      console.warn('[drop] no dataTransfer');
      return;
    }

    // Diagnostic logging — helps see what UXP exposes
    var info = {
      types: dt.types ? Array.prototype.slice.call(dt.types) : [],
      filesLength: (dt.files && dt.files.length) || 0,
      itemsLength: (dt.items && dt.items.length) || 0,
    };
    console.log('[drop] dataTransfer:', JSON.stringify(info));

    var attached = 0;

    // ── Method 1: dataTransfer.files (standard HTML5) ─────────────────────
    if (dt.files && dt.files.length > 0) {
      for (var i = 0; i < dt.files.length; i++) {
        var f = dt.files[i];
        console.log('[drop] file[' + i + ']:', f.name, f.type, f.size);
        if (f.type && f.type.startsWith('image/')) { attachFromBlob(f); attached++; }
        else if (f.name && /\.(png|jpg|jpeg|webp|gif)$/i.test(f.name)) { attachFromBlob(f); attached++; }
      }
    }

    // ── Method 2: dataTransfer.items[].getAsFile() ────────────────────────
    if (attached === 0 && dt.items && dt.items.length > 0) {
      for (var k = 0; k < dt.items.length; k++) {
        var item = dt.items[k];
        console.log('[drop] item[' + k + ']:', item.kind, item.type);
        if (item.kind === 'file') {
          try {
            var blob = item.getAsFile();
            if (blob) {
              console.log('[drop]   getAsFile →', blob.name, blob.type, blob.size);
              if (blob.type.startsWith('image/') || /\.(png|jpg|jpeg|webp|gif)$/i.test(blob.name || '')) {
                attachFromBlob(blob);
                attached++;
              }
            }
          } catch(err) { console.warn('[drop]   getAsFile error:', err.message); }
        }
      }
    }

    // ── Method 3: text/uri-list or text/plain → file path via UXP storage ──
    var uriPaths = [];
    if (attached === 0) {
      var pathStr = '';
      try { pathStr = dt.getData('text/uri-list') || dt.getData('text/plain') || ''; } catch(e) {}
      console.log('[drop] text data:', pathStr.slice(0, 200));
      var paths = pathStr.split(/[\r\n]+/).map(function(s){return s.trim();}).filter(Boolean);
      for (var p = 0; p < paths.length; p++) {
        var raw = paths[p];
        // Strip the file:// prefix to get an absolute POSIX path for UXP
        var pth = raw.replace(/^file:\/\//, '');
        if (/\.(png|jpg|jpeg|webp|gif)$/i.test(pth)) {
          uriPaths.push(pth);
          var ok = await tryLoadByPath(pth);
          if (ok) attached++;
        }
      }
    }

    // ── Method 4: bridge fallback — bridge reads the file server-side ───────
    if (attached === 0 && uriPaths.length > 0) {
      console.log('[drop] UXP storage failed, trying bridge fallback…');
      for (var bp = 0; bp < uriPaths.length; bp++) {
        var bok = await tryLoadViaBridge(uriPaths[bp]);
        if (bok) attached++;
      }
    }

    if (attached === 0) {
      console.warn('[drop] no images attached — UXP may not support Finder drag-drop and bridge fallback failed.');
      dragTarget.classList.add('drop-failed');
      setTimeout(function() { dragTarget.classList.remove('drop-failed'); }, 600);
    } else {
      console.log('[drop] attached', attached, 'image(s)');
    }
  });

  // ── Clipboard paste (works inside textarea OR dropzone) ─────────────────
  function handlePaste(e) {
    if (!e.clipboardData || !e.clipboardData.items) return;
    var items = e.clipboardData.items;
    var attached = 0;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault();
        var blob = items[i].getAsFile();
        attachFromBlob(blob, 'pasted-' + Date.now() + '.png');
        attached++;
      }
    }
  }
  msgInput.addEventListener('paste', handlePaste);
  // Also listen on the whole input area so paste works anywhere in that zone
  if (inputArea) inputArea.addEventListener('paste', handlePaste);

  // Init
  window.renderAttachBar();
})();

// ═══════════════════════════════════════════════════════════════════════════
// TAB SWITCHING
// ═══════════════════════════════════════════════════════════════════════════
document.querySelectorAll('.tab-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    var tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.toggle('active', b === btn); });
    document.querySelectorAll('.tab-panel').forEach(function(p) {
      p.classList.toggle('active', p.id === 'tab-' + tab);
    });
    closeSettingsPanel();
    // Resize VoiceGen textareas when tab becomes visible
    if (tab === 'voicegen') {
      var _vgScript = document.getElementById('vgScript');
      var _vgSfx    = document.getElementById('vgSfxText');
      var _vgMusic  = document.getElementById('vgMusicPrompt');
      if (_vgScript) vgAutoResize(_vgScript);
      if (_vgSfx)    vgAutoResize(_vgSfx);
      if (_vgMusic)  vgAutoResize(_vgMusic);
    }
    // Close voice dropdown (panel is portaled to body, close directly)
    var _vdp = document.getElementById('vgVoiceDropPanel');
    if (_vdp) _vdp.style.display = 'none';
    var _vdt = document.getElementById('vgVoiceDropTrigger');
    if (_vdt) _vdt.classList.remove('is-open');
  });
});

// ── SAC: Project bin traversal (premierepro UXP API) ──────────────────────
// The modern API uses the cast() pattern (like ClipProjectItem.cast above):
//   project.getRootItem()        → root FolderItem
//   ppro.FolderItem.cast(item)   → FolderItem or null (null = not a folder)
//   folderItem.getItems()        → child ProjectItem[]
//   item.name / item.getName()   → display name

async function sacGetItemName(item) {
  if (!item) return '';
  try { if (item.name) return String(item.name); } catch(e) {}
  if (typeof item.getName === 'function') {
    try { var n = item.getName(); if (n && typeof n.then === 'function') n = await n; if (n) return String(n); } catch(e) {}
  }
  return '';
}

// Return child items of a folder, or [] if it's not a folder (clip/sequence).
async function sacGetFolderChildren(item) {
  if (!item) return [];
  var folder = item;
  // Cast to FolderItem. Null = clip/sequence → return [] immediately (not a folder).
  // Only if cast throws (broken cast API) do we fall through and try getItems() anyway.
  try {
    if (ppro && ppro.FolderItem && typeof ppro.FolderItem.cast === 'function') {
      var f = ppro.FolderItem.cast(item);
      if (!f) return []; // Not a folder — no children
      folder = f;
    }
  } catch(e) {
    // cast threw (shouldn't happen but might in some Premiere versions)
    // fall through to try getItems() on the raw item
  }
  try {
    if (typeof folder.getItems === 'function') {
      var items = folder.getItems();
      if (items && typeof items.then === 'function') items = await items;
      return collectionToArray(items);
    }
  } catch(e) { console.warn('[SAC] getItems err:', e.message); }
  return [];
}

// Walk the whole project tree (BFS) and return [{name, item, parent}, ...].
// `parent` is the immediate folder's name ('' for top-level items) — needed to
// match cutsheet entries like "Senyue 70" = folder "Senyue" + clip "70".
// Classify a bin item → 'sequence' | 'video' | 'audio' | 'image' | 'other'.
// Extension is the reliable split for video/audio/image (UXP MediaType only knows
// VIDEO/AUDIO — a still is "video"); extensionless items are checked via isSequence().
async function sacItemMediaType(rawItem, name) {
  var ext = (String(name).match(/\.([a-z0-9]+)$/i) || ['', ''])[1].toLowerCase();
  if (/^(mov|mp4|mxf|mkv|avi|m4v|mpg|mpeg|webm|m2ts|mts|wmv|flv|r3d|braw|m2v|vob)$/.test(ext)) return 'video';
  if (/^(wav|mp3|m4a|aac|flac|ogg|oga|aif|aiff|wma|caf)$/.test(ext))                          return 'audio';
  if (/^(png|jpg|jpeg|tif|tiff|psd|gif|bmp|exr|tga|ai|eps|heic|heif|webp|svg|dpx)$/.test(ext)) return 'image';
  // No known media extension → likely a sequence (or extensionless media).
  try {
    var clip = (ppro && ppro.ClipProjectItem && ppro.ClipProjectItem.cast) ? ppro.ClipProjectItem.cast(rawItem) : null;
    if (clip && typeof clip.isSequence === 'function') {
      var sq = clip.isSequence();
      if (sq && typeof sq.then === 'function') sq = await sq;
      if (sq) return 'sequence';
    }
  } catch (e) {}
  return 'other';
}

async function sacCollectBinItems(rootItem) {
  var out = [];
  // path = full folder path of the node (branch); name = its leaf name.
  var queue = [{ item: rootItem, name: '', path: '' }];
  var guard = 0;
  while (queue.length && guard < 10000) {
    guard++;
    var node = queue.shift();
    var children = await sacGetFolderChildren(node.item);
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      var name  = await sacGetItemName(child);
      var isFolder = false;
      try { if (ppro && ppro.FolderItem && ppro.FolderItem.cast) isFolder = !!ppro.FolderItem.cast(child); } catch(e) {}
      var mediaType = isFolder ? 'folder' : await sacItemMediaType(child, name);
      // parent = immediate folder leaf (for "Senyue 70" matching); path = full branch.
      out.push({ name: name, item: child, parent: node.name, path: node.path || '', isFolder: isFolder, mediaType: mediaType });
      queue.push({ item: child, name: name, path: node.path ? (node.path + ' / ' + name) : name });
    }
  }
  return out;
}

// Normalize for name matching: lowercase, strip a trailing file extension, then
// treat separators ( - _ . ( ) [ ] / \ ) as spaces and collapse whitespace.
// This makes "K2 v4 - op1.mp4" == "K2 v4 op1" and "Frame v4 1-4x5" == "Frame v4 1 4x5",
// fixing matches that failed before because hyphens/dashes were kept literally.
function sacNorm(s) {
  // NFC FIRST: macOS stores filenames decomposed (NFD) while pasted cutsheet text is
  // usually composed (NFC). Without this, "diễn tả" from the bin ≠ "diễn tả" from the
  // sheet byte-for-byte, so even a 100%-identical name fails to match. Unify both forms.
  return String(s || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, '')      // strip trailing extension (.mp4/.mov/.png/...)
    .replace(/[-_.()\[\]/\\]+/g, ' ')     // separators → space
    .replace(/\s+/g, ' ')
    .trim();
}

// Levenshtein edit distance (for small-typo fuzzy matching).
function sacLev(a, b) {
  a = a || ''; b = b || '';
  var m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  var prev = [], cur = [], i, j;
  for (j = 0; j <= n; j++) prev[j] = j;
  for (i = 1; i <= m; i++) {
    cur[0] = i;
    for (j = 1; j <= n; j++) {
      var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

// Natural comparator: "Clip 2" < "Clip 10" (numeric chunks compared as numbers),
// case/diacritic-insensitive enough via sacNorm. Drives A→Z, 1→99 ordering.
function sacNatCmp(a, b) {
  var ax = sacNorm(a).match(/(\d+|\D+)/g) || [];
  var bx = sacNorm(b).match(/(\d+|\D+)/g) || [];
  for (var i = 0; i < Math.min(ax.length, bx.length); i++) {
    if (ax[i] === bx[i]) continue;
    var an = /^\d/.test(ax[i]), bn = /^\d/.test(bx[i]);
    if (an && bn) { var d = parseInt(ax[i], 10) - parseInt(bx[i], 10); if (d) return d; }
    else return ax[i] < bx[i] ? -1 : 1;
  }
  return ax.length - bx.length;
}

// Match a target name against collected items. Folders are NEVER matched (a folder
// can't be placed on the timeline). Passes: (1) exact (ext-tolerant), (2) prefix at
// a word boundary, (3) folder-hint + clip, (4) fuzzy (small typo, unique + tight).
function sacMatchBinItem(items, targetName) {
  var t    = sacNorm(targetName);
  var tNoX = t.replace(/\.[^.]+$/, '');

  // Pass 1: exact match (with or without file extension)
  for (var i = 0; i < items.length; i++) {
    if (items[i].isFolder) continue;
    var cn    = sacNorm(items[i].name);
    var cnNoX = cn.replace(/\.[^.]+$/, '');
    if (cn === t || cnNoX === t || cn === tNoX || cnNoX === tNoX) return items[i].item;
  }
  // Pass 2: bin name starts with the target followed by a boundary char
  for (var k = 0; k < items.length; k++) {
    if (items[k].isFolder) continue;
    var name = sacNorm(items[k].name);
    if (tNoX && name.indexOf(tNoX) === 0) {
      var next = name.charAt(tNoX.length);
      if (next === '' || /[\s._\-]/.test(next)) return items[k].item;
    }
  }
  // Pass 3: folder + clip. Cutsheet "Senyue 62" → a clip named "62" inside a
  // folder whose name *contains* "Senyue" (e.g. "Studio Senyue/62.MOV").
  var toks = t.split(' ').filter(Boolean);
  if (toks.length >= 2) {
    for (var s = 1; s < toks.length; s++) {
      var folderPart = toks.slice(0, s).join(' ');
      var clipPart   = toks.slice(s).join(' ');
      if (!folderPart) continue;
      for (var m = 0; m < items.length; m++) {
        if (items[m].isFolder || !items[m].parent) continue;
        var nameNoX = sacNorm(items[m].name).replace(/\.[^.]+$/, '');
        var par     = sacNorm(items[m].parent);
        var clipOk = (nameNoX === clipPart) ||
                     (nameNoX.length > clipPart.length &&
                       nameNoX.slice(-(clipPart.length + 1)) === (' ' + clipPart)) ||
                     (nameNoX.length > clipPart.length &&
                       nameNoX.indexOf(clipPart) === 0 &&
                       /[\s._\-\(]/.test(nameNoX.charAt(clipPart.length)));
        var folderOk = par.indexOf(folderPart) !== -1;
        if (clipOk && folderOk) return items[m].item;
      }
    }
  }
  // Pass 4: fuzzy typo tolerance, e.g. "K10 opt1" ↔ "K10 op1". Only over clips,
  // only the UNIQUE closest within a tight threshold, so we never silently bind
  // the wrong clip when several are equally close.
  var best = null, bestD = Infinity, tie = false;
  for (var f = 0; f < items.length; f++) {
    if (items[f].isFolder) continue;
    var cand = sacNorm(items[f].name).replace(/\.[^.]+$/, '');
    var d = sacLev(tNoX, cand);
    if (d < bestD) { bestD = d; best = items[f].item; tie = false; }
    else if (d === bestD) { tie = true; }
  }
  // Accept only a very close unique match: ≤20% of the name length, capped at 2.
  // NO floor of 1 — short codes are exact identifiers, so "K5" must NOT fuzzy-match
  // "D5"/"H5" (1-char diff). fuzzMax = 0 for names < 5 chars → fuzzy off for them;
  // longer names still tolerate a typo ("K10 opt1" ↔ "K10 op1").
  var fuzzMax = Math.min(2, Math.floor(tNoX.length * 0.2));
  if (best && !tie && fuzzMax >= 1 && bestD <= fuzzMax) return best;
  return null;
}

// Count how many DISTINCT bin items match a source name.
// Ambiguous = multiple EXACT (Pass 1) matches, OR zero exact + multiple Pass 2.
// If exactly 1 exact match exists, it's NOT ambiguous even if Pass 2 finds more.
function sacCountBinMatches(items, targetName) {
  var t    = sacNorm(targetName);
  var tNoX = t.replace(/\.[^.]+$/, '');

  // Count Pass 1 exact matches first (folders excluded — not placeable sources)
  var exactCount = items.filter(function(b) {
    if (b.isFolder) return false;
    var cn   = sacNorm(b.name);
    var cnNoX = cn.replace(/\.[^.]+$/, '');
    return cn === t || cnNoX === t || cn === tNoX || cnNoX === tNoX;
  }).length;

  // 1 exact match → unambiguous (even if Pass 2 finds more prefix matches)
  if (exactCount === 1) return 1;
  // 0+ exact matches → also count Pass 2 prefix matches for full picture
  return items.filter(function(b) {
    if (b.isFolder) return false;
    var cn   = sacNorm(b.name);
    var cnNoX = cn.replace(/\.[^.]+$/, '');
    if (cn === t || cnNoX === t || cn === tNoX || cnNoX === tNoX) return true;
    if (tNoX && cn.indexOf(tNoX) === 0) {
      var next = cn.charAt(tNoX.length);
      if (next === '' || /[\s._\-]/.test(next)) return true;
    }
    return false;
  }).length;
}

// ── Voice-over bin helpers ─────────────────────────────────────────────────
// Find a bin whose name matches "voice over" / "voiceover" / "vo" near root.
// Creates it at root if not found.
async function ppGetOrCreateVOBin(proj) {
  if (!proj) return null;
  var root = null;
  try {
    root = typeof proj.getRootItem === 'function' ? proj.getRootItem() : proj.rootItem;
    if (root && typeof root.then === 'function') root = await root;
  } catch(e) { return null; }
  if (!root) return null;

  // Search direct children of root (1 level)
  try {
    var children = await sacGetFolderChildren(root);
    for (var i = 0; i < children.length; i++) {
      var n = await sacGetItemName(children[i]);
      if (/^(voice\s*over|vo)$/i.test(n.trim())) return children[i];
    }
  } catch(e) {}

  // Not found — create "voice over" bin at root via Action + transaction
  try {
    var createAction = root.createBinAction('voice over', false);
    var r = proj.lockedAccess(function() {
      proj.executeTransaction(function(ca) { ca.addAction(createAction); }, 'Create VO bin');
    });
    if (r && typeof r.then === 'function') await r;
    // Re-scan to find the newly created bin
    var children2 = await sacGetFolderChildren(root);
    for (var j = 0; j < children2.length; j++) {
      var n2 = await sacGetItemName(children2[j]);
      if (/^(voice\s*over|vo)$/i.test(n2.trim())) return children2[j];
    }
  } catch(e) { console.warn('[ppVO] createBin failed:', e.message); }
  return null;
}

// Move a ProjectItem to the "voice over" bin (find or create it).
async function ppMoveToVOBin(item, proj) {
  if (!item || !proj) return;
  try {
    var binRaw = await ppGetOrCreateVOBin(proj);
    if (!binRaw) return;

    // Must cast to FolderItem — createMoveItemAction only exists on FolderItem, not ProjectItem
    var bin = (ppro && ppro.FolderItem) ? ppro.FolderItem.cast(binRaw) : binRaw;
    if (!bin) { console.warn('[ppVO] FolderItem.cast returned null'); return; }

    if (typeof bin.createMoveItemAction !== 'function') {
      console.warn('[ppVO] createMoveItemAction still not found after cast');
      return;
    }

    var action = bin.createMoveItemAction(item, bin);
    var rs = proj.lockedAccess(function() {
      proj.executeTransaction(function(ca) { ca.addAction(action); }, 'Move to VO bin');
    });
    if (rs && typeof rs.then === 'function') await rs;
    console.log('[ppVO] Moved to voice over bin');
  } catch(e) { console.warn('[ppVO] ppMoveToVOBin failed:', e.message); }
}

// Single source of truth for the "Move to Voice Over bin" toggle. Every import
// path must gate the VO-bin move through this so the checkbox is always honored.
function ppShouldMoveToVOBin() {
  var cb = document.getElementById('vgMoveToVOBin');
  return !!(cb && cb.checked);
}
// Move only when the toggle is on.
async function ppMoveToVOBinIfEnabled(item, proj) {
  if (!ppShouldMoveToVOBin()) return;
  await ppMoveToVOBin(item, proj);
}

// ═══════════════════════════════════════════════════════════════════════════
// SUPER AUTO CUT MODULE — Phase 1: Spreadsheet UI + Block Parsing
// ═══════════════════════════════════════════════════════════════════════════
(function() {
  'use strict';
  var $ = function(id) { return document.getElementById(id); };

  // FontAwesome 6 (solid) icon SVG paths inline — UXP can't load icon fonts
  // (<i class="fa-...">). NOTE: UXP's SVG renderer ignores fill="currentColor",
  // so the colour is baked straight into each <svg fill="..."> instead of via CSS.
  var SAC_ICON_PATHS = {
    folder:   { vb: '0 0 512 512', d: 'M64 480H448c35.3 0 64-28.7 64-64V160c0-35.3-28.7-64-64-64H298.5c-17 0-33.3-6.7-45.3-18.7L226.7 50.7c-12-12-28.3-18.7-45.3-18.7H64C28.7 32 0 60.7 0 96V416c0 35.3 28.7 64 64 64z' },
    video:    { vb: '0 0 576 512', d: 'M0 128C0 92.7 28.7 64 64 64H320c35.3 0 64 28.7 64 64V384c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V128zM559.1 99.8c10.4 5.6 16.9 16.4 16.9 28.2V384c0 11.8-6.5 22.6-16.9 28.2s-23 5-32.9-1.6l-96-64L416 337.1V320 192 174.9l14.2-9.5 96-64c9.8-6.5 22.4-7.2 32.9-1.6z' },
    audio:    { vb: '0 0 512 512', d: 'M499.1 6.3c8.1 6 12.9 15.6 12.9 25.7v72V368c0 44.2-43 80-96 80s-96-35.8-96-80s43-80 96-80c11.2 0 22 1.6 32 4.6V147L192 223.8V432c0 44.2-43 80-96 80s-96-35.8-96-80s43-80 96-80c11.2 0 22 1.6 32 4.6V200 128c0-14.1 9.3-26.6 22.8-30.7l320-96c9.7-2.9 20.2-1.1 28.3 5z' },
    image:    { vb: '0 0 512 512', d: 'M0 96C0 60.7 28.7 32 64 32H448c35.3 0 64 28.7 64 64V416c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V96zM323.8 202.5c-4.5-6.6-11.9-10.5-19.8-10.5s-15.4 3.9-19.8 10.5l-87 127.6L170.7 297c-4.6-5.7-11.5-9-18.7-9s-14.2 3.3-18.7 9l-64 80c-5.8 7.2-6.9 17.1-2.9 25.4s12.4 13.6 21.6 13.6h96 32H424c8.9 0 17.1-4.9 21.2-12.8s3.6-17.4-1.4-24.7l-120-176zM112 192a48 48 0 1 0 0-96 48 48 0 1 0 0 96z' },
    sequence: { vb: '0 0 512 512', d: 'M0 128C0 92.7 28.7 64 64 64H448c35.3 0 64 28.7 64 64V384c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V128zm32 32v32c0 8.8 7.2 16 16 16H80c8.8 0 16-7.2 16-16V160c0-8.8-7.2-16-16-16H48c-8.8 0-16 7.2-16 16zm384 0v32c0 8.8 7.2 16 16 16h32c8.8 0 16-7.2 16-16V160c0-8.8-7.2-16-16-16H432c-8.8 0-16 7.2-16 16zM32 288v32c0 8.8 7.2 16 16 16H80c8.8 0 16-7.2 16-16V288c0-8.8-7.2-16-16-16H48c-8.8 0-16 7.2-16 16zm384 0v32c0 8.8 7.2 16 16 16h32c8.8 0 16-7.2 16-16V288c0-8.8-7.2-16-16-16H432c-8.8 0-16 7.2-16 16zM160 160V352c0 17.7 14.3 32 32 32H320c17.7 0 32-14.3 32-32V160c0-17.7-14.3-32-32-32H192c-17.7 0-32 14.3-32 32z' },
    other:    { vb: '0 0 384 512', d: 'M0 64C0 28.7 28.7 0 64 0H224V128c0 17.7 14.3 32 32 32H384V448c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V64zm384 64H256V0L384 128z' }
  };
  var SAC_ICON_COLOR = { folder: '#eab308', video: '#22c55e', audio: '#a855f7', image: '#f59e0b', sequence: '#ec4899', other: 'rgba(255,255,255,0.55)' };
  function sacIconEl(name) {
    var def = SAC_ICON_PATHS[name] || SAC_ICON_PATHS.other;
    var color = SAC_ICON_COLOR[name] || SAC_ICON_COLOR.other;
    var s = document.createElement('span');
    s.className = 'sac-ic';
    // fill must be ON the <path> — UXP doesn't inherit fill from the parent <svg>.
    s.innerHTML = '<svg viewBox="' + def.vb + '" width="13" height="13"><path fill="' + color + '" d="' + def.d + '"/></svg>';
    return s;
  }
  // Set an element's content to a flat icon (from the global PI_ICONS set) + text.
  // Text goes through createTextNode so filenames with special chars stay safe.
  function sacLabelIcon(el, iconName, color, size, text) {
    el.innerHTML = '<span class="p-ic" style="margin-right:6px">' + pluginIconSVG(iconName, size || 12, color || null) + '</span>';
    el.appendChild(document.createTextNode(text == null ? '' : text));
  }
  // Inline folder-icon glyph (yellow) for embedding mid-sentence in status messages.
  function sacFolderIco() {
    return '<span class="sac-ic" style="margin:0 2px;vertical-align:-2px">' + pluginIconSVG('folder', 11, '#eab308') + '</span>';
  }
  // Escape user/clip-derived text before it goes into innerHTML.
  function sacEsc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Given a matched ProjectItem, return a short "…/folder/clipName" label showing
  // WHERE in the bin the source actually matched (so the user can confirm it's the
  // right clip). Looks the item up in the last bin scan; falls back to the bare
  // clip name when it sits at the project root.
  function sacMatchedPathLabel(item) {
    if (!item) return '';
    var items = sacBinItems || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].item === item) {
        var rec = items[i];
        return rec.parent ? ('…/' + rec.parent + '/' + rec.name) : rec.name;
      }
    }
    return '';
  }
  // Set a found-source row's inline message to show which bin clip it matched.
  function sacSetMatchMsg(msgEl, item) {
    if (!msgEl) return;
    var label = sacMatchedPathLabel(item);
    if (label) {
      msgEl.innerHTML = sacFolderIco() + '<span class="sac-srcMatchPath">' + sacEsc(label) + '</span>';
      msgEl.className = 'sac-srcMsg is-match';
    } else {
      msgEl.textContent = ''; msgEl.className = 'sac-srcMsg';
    }
  }

  var rowSeq = 0;
  var parsedBlocks = [];
  var sacSourceMap = {}; // name → ProjectItem|null, populated by sacValidateSources
  var sacBinItems  = []; // full flat list from last bin scan (persisted for hint UI)
  var sacBindOverrides = {}; // sacNorm(originalCutsheetName) → bound display name (survives re-parse)

  // ── Persistent binds (per open project) ───────────────────────────────────
  // Binds are remembered in localStorage keyed by project name, so cutting task 2
  // in the same project re-uses task 1's binds instead of re-binding every source.
  var SAC_BINDS_LS = 'sac_binds_v1'; // { projKey: { normOrigName: label } }
  var sacProjKey   = '';             // current project key (set on each validate)
  function sacLoadBindStore() {
    try { return JSON.parse(localStorage.getItem(SAC_BINDS_LS) || '{}') || {}; }
    catch(e) { return {}; }
  }
  function sacSaveBindStore(store) {
    try { localStorage.setItem(SAC_BINDS_LS, JSON.stringify(store)); } catch(e) {}
  }
  async function sacCurrentProjectKey() {
    try {
      var p = await getActiveProject();
      var nm = p && p.name;
      if (nm && typeof nm.then === 'function') nm = await nm;
      return String(nm || (p && p.guid) || '');
    } catch(e) { return ''; }
  }
  // Merge the open project's saved binds into the live override map.
  function sacLoadProjectBinds(projKey) {
    sacProjKey = projKey || '';
    if (!sacProjKey) return;
    var saved = sacLoadBindStore()[sacProjKey];
    if (saved) for (var k in saved) if (saved.hasOwnProperty(k)) sacBindOverrides[k] = saved[k];
  }
  function sacPersistBind(normKey, label) {
    if (!sacProjKey) return;
    var store = sacLoadBindStore();
    (store[sacProjKey] = store[sacProjKey] || {})[normKey] = label;
    sacSaveBindStore(store);
  }
  function sacForgetBind(normKey) {
    if (!sacProjKey) return;
    var store = sacLoadBindStore();
    if (store[sacProjKey]) { delete store[sacProjKey][normKey]; sacSaveBindStore(store); }
  }
  var sacVoicePath  = null; // native path of the chosen/generated voice file
  var sacVoiceBusy  = false; // prevent concurrent voice ops (gen + pick racing)

  var sacValidatePassed = false;
  var sacVoiceReady     = false;
  var sacScriptPrepared = false; // normalized script already pushed to Voice Gen (auto on validate)
  var sacNormToken      = 0;     // bumped to invalidate an in-flight normalize (cancel)
  var sacNormAbort      = null;  // AbortController for the in-flight normalize fetch
  var sacValidateToken  = 0;     // bumped to invalidate an in-flight validate
  // Persistent Autocut behaviour for the "gen voice?" step on Validate. Stored in
  // localStorage (survives reloads / new cuts) instead of a session flag that used
  // to be reset every cut — that reset was why "don't ask again" never stuck.
  //   'ask'   → show the popup each Validate
  //   'auto'  → always normalize + gen voice, no popup
  //   'never' → validate only, never gen voice, no popup
  function sacGetGenVoiceMode() {
    var v = localStorage.getItem('sac_genvoice_mode');
    return (v === 'auto' || v === 'never') ? v : 'ask';
  }
  var sacNoVoiceMode    = false; // set by "Without voice" button

  // Show the cut panel (hides voice panel), update label
  function sacShowCutPanel() {
    var _ra = $('sacRunAnywayBtn'); if (_ra) _ra.style.display = 'none';
    $('sacVoicePanel').style.display = 'none';
    var lbl = $('sacCutLabel');
    if (lbl) {
      if (sacNoVoiceMode) {
        sacLabelIcon(lbl, 'scissors', '#fbbf24', 12, 'Without voice');
      } else {
        var info = $('sacVoiceInfo');
        lbl.textContent = info ? info.textContent : '✅ Voice ready';
      }
    }
    // "Chỉ video (bỏ voice)" toggle — only meaningful when voice was actually
    // aligned. Lets the user cut video-only without discarding the gen'd voice
    // (the ✕ button clears it). Hidden on the pure no-voice path (sacVoiceReady=false).
    var nvWrap = $('sacCutNoVoiceToggleWrap');
    if (nvWrap) {
      nvWrap.style.display = sacVoiceReady ? 'flex' : 'none';
      var nvChk = $('sacCutNoVoiceChk');
      if (nvChk) nvChk.checked = sacNoVoiceMode;
    }
    $('sacCutPanel').style.display = 'flex';
  }

  function sacHideCutPanel() {
    $('sacCutPanel').style.display = 'none';
    $('sacVoicePanel').style.display = 'flex';
  }

  function sacUpdateRunVisibility() {
    if (sacValidatePassed && (sacVoiceReady || sacNoVoiceMode)) {
      sacShowCutPanel();
    } else {
      sacHideCutPanel();
    }
  }

  // ── Method switching ────────────────────────────────────────────────────
  document.querySelectorAll('.sac-methodBtn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.sac-methodBtn').forEach(function(b) {
        b.classList.remove('is-active');
      });
      btn.classList.add('is-active');
      var method = btn.dataset.method;
      $('sacPanelManual').style.display     = (method === 'manual')     ? 'flex' : 'none';
      $('sacPanelScreenshot').style.display = (method === 'screenshot') ? 'flex' : 'none';
    });
  });

  // ── TSV parser — handles quoted cells with embedded newlines ────────────
  // Google Sheets wraps cells containing \n or \t in double-quotes.
  // Standard: tab = col sep, \n = row sep, "" inside quotes = literal "
  function parseTSV(text) {
    var rows = [], row = [], cell = '', inQ = false, i = 0, ch, nx;
    while (i < text.length) {
      ch = text[i]; nx = text[i + 1];
      if (inQ) {
        if (ch === '"' && nx === '"') { cell += '"'; i += 2; }       // escaped quote
        else if (ch === '"')          { inQ = false; i++; }          // end quote
        else                          { cell += ch; i++; }
      } else {
        if      (ch === '"')                      { inQ = true; i++; }
        else if (ch === '\t')                     { row.push(cell); cell = ''; i++; }
        else if (ch === '\n' || ch === '\r') {
          row.push(cell); cell = '';
          if (row.some(function(c) { return c !== ''; })) rows.push(row);
          row = [];
          if (ch === '\r' && nx === '\n') i++;    // CRLF
          i++;
        } else { cell += ch; i++; }
      }
    }
    // flush last cell/row
    row.push(cell);
    if (row.some(function(c) { return c !== ''; })) rows.push(row);
    return rows;
  }

  // ── Expand multi-line / multi-value cells into separate rows ─────────────
  // Handles three cases:
  //   A) text cell has \n  → split text into rows (first keeps time+src)
  //   B) time cell has \n  → split time values into rows (first keeps text+src)
  //   C) time cell has space-separated timestamps like "0:04 0:07 0:13"
  var TS_RE = /^\d+:\d+(?:-\d+:\d+)?$/; // e.g. "0:04" or "0:01-0:08"
  // Connector between two timestamps in ONE cell: the word "và"/"and" (needs
  // surrounding spaces so it isn't matched inside a name) or the symbols & + , ; .
  // NFC so a decomposed "và" (v + a + combining grave) still matches.
  var TIME_CONNECTOR_RE = /\s+(?:và|and)\s+|\s*[&+,;]\s*/i;
  function splitTimes(t) {
    if (!t) return [t];
    t = String(t).normalize('NFC');
    if (t.indexOf('\n') !== -1) {
      // Multi-line time cell: keep lines that ARE a timecode — a digit at the start,
      // OR an optional Vietnamese second-prefix ("Giây 11", "giay 24, 26", "s5")
      // then a digit (the prefix is stripped later by parseSourceTime). Descriptive
      // lines like "lặp liên tục với 3 màu" start with a word → dropped as before.
      // NOTE: dropping a real time line shifts every following time↔source pair, so
      // this filter must NOT lose "Giây …" lines (was causing time misalignment).
      var tcLines = t.split('\n').map(function(s){ return s.trim(); })
        .filter(Boolean).filter(function(s){ return /^(?:gi[aâ]y|giay|s)?\s*\d/i.test(s); });
      return tcLines.length ? tcLines : [t];
    }
    // Split on the connector ("0:02-0:08 và 0:10-0:15") OR plain whitespace, so two
    // timecodes joined by "và"/"and"/&/+/,/; become two separate timestamps.
    var parts = t.trim().split(/\s+(?:và|and)\s+|\s*[&+,;]\s*|\s+/i).filter(Boolean);
    if (parts.length > 1 && parts.every(function(p){ return TS_RE.test(p); })) return parts;
    return [t];
  }
  function expandRows(rows) {
    var out = [];
    var i = 0;
    while (i < rows.length) {
      var cols = rows[i];
      var text = cols[0] || '', time = cols[1] || '', src = cols[2] || '';

      // Text col: ALWAYS flatten to 1 line (join \n with space)
      if (text.indexOf('\n') !== -1) {
        text = text.split('\n').map(function(l){ return l.trim(); }).filter(Boolean).join(' ');
      }

      // When BOTH time and source cells are multi-line, the blank lines are ALIGNMENT
      // padding that keeps each timecode lined up with its source. Filtering blanks out
      // of each column independently (the generic path below) collapses the two columns
      // by DIFFERENT amounts and mis-pairs them — a cut then jumps to the source BELOW
      // it. So zip by RAW line index instead: a blank source line inherits the source
      // ABOVE (merged/continued source), and lines with no real timecode are skipped.
      if (time.indexOf('\n') !== -1 && src.indexOf('\n') !== -1) {
        var tLines = time.split('\n').map(function(s){ return s.trim(); });
        var sLines = src.split('\n').map(function(s){ return s.trim(); });
        var n = Math.max(tLines.length, sLines.length);
        var lastSrc = '', firstEmit = true;
        for (var k = 0; k < n; k++) {
          var tl = tLines[k] || '';
          if (sLines[k]) lastSrc = sLines[k]; // non-blank source → update inheritance
          // Only emit for a real timecode line (digit / "Giây …" prefix). Blank or
          // descriptive lines are padding/notes → must NOT create a bogus clip.
          if (!/^(?:gi[aâ]y|giay|s)?\s*\d/i.test(tl)) continue;
          out.push([firstEmit ? text : '', tl, lastSrc]);
          firstEmit = false;
        }
        i++;
        continue;
      }

      // Split time and source into arrays
      var times   = splitTimes(time); // handles \n and space-separated timestamps
      var srcArr  = src.indexOf('\n') !== -1
        ? src.split('\n').map(function(s){ return s.trim(); }).filter(Boolean)
        : [src];

      var rowCount = Math.max(times.length, srcArr.length);

      if (rowCount > 1) {
        // Zip time + source, expanding to rowCount rows
        for (var r = 0; r < rowCount; r++) {
          var rText = r === 0 ? text : '';
          // When there's a single timecode but multiple sources, every row shares
          // that one cleaned timecode (times[0]) — not the raw multi-line blob.
          var rTime = times.length > 1 ? (times[r] || '') : (times[0] || '');
          var rSrc  = srcArr.length > 1 ? (srcArr[r]  || '') : src;
          out.push([rText, rTime, rSrc]);
        }
        i++;
        continue;
      }

      out.push([text, time, src]);
      i++;
    }
    return out;
  }

  // ── Row factory ─────────────────────────────────────────────────────────
  // Fill ONE column downward starting at `inp`'s row — creates rows as needed and
  // keeps blank lines (1 line = 1 row) so columns stay aligned. Does NOT touch the
  // other two columns. Used for single-column paste (no tabs).
  function sacFillColumnDown(inp, colIdx, lines) {
    var startRow = inp.parentNode;
    while (startRow && !(startRow.classList && startRow.classList.contains('sac-row'))) startRow = startRow.parentNode;
    var body = $('sacBody');
    if (!startRow || !body) return;
    var rows = Array.prototype.slice.call(body.querySelectorAll('.sac-row'));
    var startIdx = rows.indexOf(startRow);
    if (startIdx === -1) return;
    for (var k = 0; k < lines.length; k++) {
      var rowEl = rows[startIdx + k];
      if (!rowEl) {                         // ran out of rows → append
        createRow('', '', '');
        rows = Array.prototype.slice.call(body.querySelectorAll('.sac-row'));
        rowEl = rows[startIdx + k];
      }
      if (!rowEl) break;
      // colIdx is the focused column's SEMANTIC index; look it up by tag so it works
      // no matter where the column physically sits after a reorder.
      var cell = sacInputBySem(rowEl, colIdx);
      if (cell) cell.value = lines[k].trim();
    }
    // Editing the source column invalidates a prior validate pass
    if (colIdx === 2 && sacValidatePassed) { sacValidatePassed = false; sacUpdateRunVisibility(); }
  }

  // Fill MULTIPLE columns downward starting at (focused row, focused cell). `focusedSem`
  // is the focused input's SEMANTIC index (0=text,1=time,2=src). grid col c maps to the
  // DISPLAY position (focusedDisp + c) → whatever semantic currently sits there, so paste
  // follows the on-screen column order. Preserves columns left of the focus and rows above.
  function sacFillGridDown(inp, focusedSem, grid) {
    var startRow = inp.parentNode;
    while (startRow && !(startRow.classList && startRow.classList.contains('sac-row'))) startRow = startRow.parentNode;
    var body = $('sacBody');
    if (!startRow || !body) return;
    var rows = Array.prototype.slice.call(body.querySelectorAll('.sac-row'));
    var startIdx = rows.indexOf(startRow);
    if (startIdx === -1) return;
    var fdisp = sacSemToDisp(focusedSem);
    var touchedSrc = false;
    for (var k = 0; k < grid.length; k++) {
      var rowEl = rows[startIdx + k];
      if (!rowEl) {
        createRow('', '', '');
        rows = Array.prototype.slice.call(body.querySelectorAll('.sac-row'));
        rowEl = rows[startIdx + k];
      }
      if (!rowEl) break;
      for (var c = 0; c < grid[k].length; c++) {
        var disp = fdisp + c;
        if (disp > 2) break;                       // only 3 columns exist
        var sem = SAC_SEM[SAC_COL_ORDER[disp]];     // display pos → semantic input index
        var cell = sacInputBySem(rowEl, sem);
        if (cell) { cell.value = (grid[k][c] || '').trim(); if (sem === 2) touchedSrc = true; }
      }
    }
    if (touchedSrc && sacValidatePassed) { sacValidatePassed = false; sacUpdateRunVisibility(); }
  }

  function makeInput(placeholder, colIdx) {
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'sac-input';
    inp.placeholder = placeholder;
    inp.dataset.colIdx = String(colIdx || 0);
    inp.addEventListener('focus', function() {
      if (window.claimKeyboard) window.claimKeyboard();
    });
    inp.addEventListener('blur', function() {
      if (window.releaseKeyboard) window.releaseKeyboard();
    });
    // Multi-row paste from Google Sheets / Excel
    inp.addEventListener('paste', function(e) {
      // clipboardData is only valid during the event → capture synchronously now.
      var raw = e.clipboardData && e.clipboardData.getData('text/plain');
      if (!raw || raw.indexOf('\n') === -1) return; // single cell → normal paste
      e.preventDefault();
      // UXP often IGNORES preventDefault and still dumps the blob into the focused input.
      // So defer our distribution to the next tick — it then runs AFTER the native paste
      // and our values become the final state (focused cell gets line 0, rest fill down).
      setTimeout(function() {
        // Build a grid; a single-column copy from Sheets can still carry stray trailing
        // tabs (empty adjacent cells), so decide by how many columns actually have data —
        // not merely by the presence of a tab.
        var grid = raw.replace(/\r\n?/g, '\n').split('\n').map(function(l) { return l.split('\t'); });
        if (grid.length && grid[grid.length - 1].every(function(v) { return v.trim() === ''; })) grid.pop(); // drop trailing empty line
        if (!grid.length) return;
        var maxCols = 0;
        grid.forEach(function(c) { var n = 0; for (var i = 0; i < c.length; i++) if (c[i].trim() !== '') n = i + 1; if (n > maxCols) maxCols = n; });
        if (maxCols >= 2 && sacSemToDisp(colIdx || 0) === 0) {
          // FULL CUTSHEET pasted into the LEFTMOST column → rebuild the whole table.
          // Pasted columns are in DISPLAY order; remap each to its semantic slot BEFORE
          // expandRows (which expects [text,time,src] and does multi-timestamp split +
          // merged-source inheritance).
          var parsed = parseTSV(raw).map(function(cols) {
            var o = ['', '', ''];
            for (var d = 0; d < 3; d++) o[SAC_SEM[SAC_COL_ORDER[d]]] = cols[d] || '';
            return o;
          });
          var rows = expandRows(parsed);
          if (rows.length === 0) return;
          $('sacBody').innerHTML = '';
          rowSeq = 0;
          rows.forEach(function(cols) {
            createRow(
              cols[0] ? cols[0].trim() : '',
              cols[1] ? cols[1].trim() : '',
              cols[2] ? cols[2].trim() : ''
            );
          });
        } else if (maxCols >= 2) {
          // MULTI-COLUMN pasted into time/source → fill those columns down FROM the
          // focused column (col 2 paste → time+source), preserving the columns to the left.
          sacFillGridDown(inp, colIdx || 0, grid);
          var firstG = (grid[0] && grid[0][0] || '').trim();
          var fixG = function() { if (inp.value !== firstG) inp.value = firstG; };
          setTimeout(fixG, 30); setTimeout(fixG, 120); setTimeout(fixG, 300);
        } else {
          // SINGLE COLUMN → fill down ONLY the focused column, preserve the other two.
          var lines = grid.map(function(c) { return (c[0] || '').trim(); });
          sacFillColumnDown(inp, colIdx || 0, lines);
          // UXP applies the native paste LATE (after this tick), clobbering the FOCUSED
          // cell (line 0) with the whole blob — only the first cell is hit. Re-assert it
          // a few times so our line-0 value wins the race.
          var first = lines[0] || '';
          var fixFirst = function() { if (inp.value !== first) inp.value = first; };
          setTimeout(fixFirst, 30);
          setTimeout(fixFirst, 120);
          setTimeout(fixFirst, 300);
        }
      }, 0);
    });
    return inp;
  }

  function makeCell(colClass) {
    var cell = document.createElement('div');
    cell.className = 'sac-cell ' + colClass;
    return cell;
  }

  // ── Column reorder ────────────────────────────────────────────────────────
  // Columns are reordered by PHYSICALLY moving the cell elements in the DOM — NOT
  // CSS flex `order`, which UXP fails to repaint until a hover/scroll invalidates
  // the region (reflow ≠ repaint). Moving DOM nodes is a structural mutation UXP
  // must re-render, so the reorder shows instantly.
  // Inputs keep a semantic tag (dataset.colIdx: 0=text,1=time,2=src), so every
  // reader looks up by semantic regardless of physical position.
  // SAC_COL_ORDER = semantic keys in physical L→R order.
  var SAC_SEM      = { text: 0, time: 1, src: 2 };
  var SAC_COL_KEYS = ['text', 'time', 'src'];
  var SAC_COL_ORDER = ['text', 'time', 'src'];

  function sacSemToDisp(semIdx) { return SAC_COL_ORDER.indexOf(SAC_COL_KEYS[semIdx]); }

  // Find a row's input for a semantic column, independent of physical order.
  // Single-class selector only (descendant combinators are flaky in UXP); match
  // on dataset.colIdx, with a positional fallback if the tag is somehow missing.
  function sacInputBySem(row, sem) {
    var ins = row.querySelectorAll('.sac-input');
    for (var i = 0; i < ins.length; i++) {
      if (parseInt(ins[i].dataset.colIdx, 10) === sem) return ins[i];
    }
    return ins[sem] || null;
  }

  function sacLoadColOrder() {
    try {
      var s = JSON.parse(localStorage.getItem('sac_col_order'));
      if (Array.isArray(s) && s.length === 3 &&
          s.indexOf('text') >= 0 && s.indexOf('time') >= 0 && s.indexOf('src') >= 0) {
        SAC_COL_ORDER = s;
      }
    } catch (e) {}
  }
  function sacSaveColOrder() {
    try { localStorage.setItem('sac_col_order', JSON.stringify(SAC_COL_ORDER)); } catch (e) {}
  }

  // Physically reorder one container's column cells to match SAC_COL_ORDER, action
  // cell last. appendChild moves an existing node to the end, so appending in order
  // rebuilds the L→R sequence. Works for both a data row and the header row.
  function sacOrderCells(container) {
    if (!container) return;
    SAC_COL_ORDER.forEach(function(k) {
      var c = container.querySelector('.sac-col-' + k);
      if (c) container.appendChild(c);
    });
    var act = container.querySelector('.sac-col-act');
    if (act) container.appendChild(act);
  }

  // Apply current order to a single row (called for every row created)
  function sacApplyRowOrder(row) { sacOrderCells(row); }

  // Re-apply order to header + all existing rows, and sync the preset picker
  function sacApplyColOrder() {
    var body = $('sacBody');
    if (body) Array.prototype.forEach.call(body.querySelectorAll('.sac-row'), sacOrderCells);
    sacOrderCells(document.querySelector('.sac-thead'));
    var preset = document.getElementById('sacColPreset');
    if (preset) { var v = SAC_COL_ORDER.join(','); if (preset.value !== v) preset.value = v; }
  }

  // afterRow: if provided, insert new row after that element; else append
  function createRow(text, time, src, afterRow) {
    var id = ++rowSeq;
    var row = document.createElement('div');
    row.className = 'sac-row';
    row.dataset.rowId = String(id);

    var inpText = makeInput('Script text...', 0);
    var inpTime = makeInput('0:00-0:10', 1);
    var inpSrc  = makeInput('Source name', 2);
    if (text) inpText.value = text;
    if (time) inpTime.value = time;
    if (src)  inpSrc.value  = src;

    var delBtn = document.createElement('button');
    delBtn.className = 'sac-rowBtn sac-delBtn';
    delBtn.title = 'Xoá dòng này';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', function() { row.remove(); });

    var insBtn = document.createElement('button');
    insBtn.className = 'sac-rowBtn sac-insBtn';
    insBtn.title = 'Thêm dòng bên dưới';
    insBtn.textContent = '+';
    insBtn.addEventListener('click', function() { createRow('', '', '', row); });

    // Reset validate gate whenever source is edited (hint added or name changed)
    inpSrc.addEventListener('input', function() {
      if (sacValidatePassed) { sacValidatePassed = false; sacUpdateRunVisibility(); }
    });

    // Folder hint button — suggests parent folders from the last bin scan
    var hintBtn = document.createElement('div');
    hintBtn.className = 'sac-rowBtn sac-hintBtn';
    hintBtn.setAttribute('role', 'button');
    hintBtn.title = 'Thêm folder hint';
    piSetBtn(hintBtn, 'folder', null, null, 12);
    hintBtn.addEventListener('click', function() { sacShowFolderHints(inpSrc.value.trim(), inpSrc); });

    var cText = makeCell('sac-col-text'); cText.appendChild(inpText);
    var cTime = makeCell('sac-col-time'); cTime.appendChild(inpTime);
    var cSrc  = makeCell('sac-col-src');  cSrc.appendChild(inpSrc); cSrc.appendChild(hintBtn);
    var cAct  = makeCell('sac-col-act');
    cAct.appendChild(insBtn);
    cAct.appendChild(delBtn);

    row.appendChild(cText);
    row.appendChild(cTime);
    row.appendChild(cSrc);
    row.appendChild(cAct);

    var body = $('sacBody');
    if (afterRow && afterRow.nextSibling) {
      body.insertBefore(row, afterRow.nextSibling);
    } else {
      body.appendChild(row);
    }
    sacApplyRowOrder(row);   // honour current column order
    return row;
  }

  // ── Block parsing ───────────────────────────────────────────────────────
  // Rule:
  //   • Both text + source non-empty → NEW block
  //   • Only text non-empty          → add text to current block
  //   • Only source non-empty        → add source to current block
  //   • Both empty                   → skip
  // A source cell may be multi-line; on EACH line, drop anything AFTER the file
  // extension (notes like "K5.mov ref clip" → "K5.mov"). Lines without a known
  // media extension are left untouched.
  function sacStripSrcNotes(str) {
    var EXT = 'mov|mp4|mxf|mkv|avi|m4v|mpg|mpeg|wav|mp3|m4a|aac|flac|ogg|gif|png|jpg|jpeg|tif|tiff|psd|prproj|aep';
    var re = new RegExp('^(.*?\\.(?:' + EXT + '))\\b.*$', 'i');
    return String(str || '').split('\n').map(function(line) {
      return line.replace(re, '$1').trim();
    }).join('\n').trim();
  }

  function parseBlocks() {
    var rows = Array.from($('sacBody').querySelectorAll('.sac-row'));
    var data = rows.map(function(row) {
      // Read by semantic tag, not physical position — columns may be reordered.
      var it = sacInputBySem(row, 0), im = sacInputBySem(row, 1), is = sacInputBySem(row, 2);
      return {
        text: it ? it.value.trim() : '',
        time: im ? im.value.trim() : '',
        src:  is ? sacStripSrcNotes(is.value) : '',
      };
    });

    var blocks  = [];
    var current = null;

    // Split a time cell on "&", "+", "," or ";" → one clip per segment from the SAME
    // source, placed consecutively. "3-4 & 5-6", "1-2 + 2-3 + 3-4" → multiple clips.
    // Bare numbers are seconds; decimals use a DOT ("1.5"), so splitting on comma is
    // safe in this convention. Empty / no separator → a single entry.
    function srcEntries(name, time) {
      // Also split on the word "và"/"and" (with spaces) so one source with two
      // timestamps ("0:02-0:08 và 0:10-0:15") becomes two clip entries.
      var segs = String(time || '').normalize('NFC')
        .split(/\s+(?:và|and)\s+|[&+,;]/i).map(function(s) { return s.trim(); }).filter(Boolean);
      if (segs.length <= 1) return [{ name: name, time: time }];
      return segs.map(function(seg) { return { name: name, time: seg }; });
    }

    // A voice line that carries a SOURCE or a real TIMECODE starts a NEW block:
    //   • text + source             → new block
    //   • text + real timecode only → new block, inherit the previous source (merged source cell)
    //   • text only (no time/src)   → voice continuation of the current block
    //   • source/time only (no text)→ add a clip to the current block (inherit source if only a time)
    // "Real timecode" = parseSourceTime parses it, so notes like "Chạy variant" stay voice-only.
    var lastSrcName = '';
    data.forEach(function(r) {
      var hasText  = r.text !== '';
      var hasSrc   = r.src  !== '';
      var realTime = r.time !== '' && parseSourceTime(r.time).inSec !== null;
      if (!hasText && !hasSrc && r.time === '') return; // truly blank row

      if (hasText && (hasSrc || realTime)) {
        var name = hasSrc ? r.src : lastSrcName; // empty source + timecode → inherit (merged cell)
        if (hasSrc) lastSrcName = r.src;
        current = { texts: [r.text], sources: name ? srcEntries(name, r.time) : [] };
        blocks.push(current);
      } else if (hasText) {
        // Voice-only continuation (no source, no real timecode) → same block.
        if (!current) { current = { texts: [], sources: [] }; blocks.push(current); }
        current.texts.push(r.text);
      } else {
        // Source/time-only row (no text) → add a clip to the current block.
        if (!current) { current = { texts: [], sources: [] }; blocks.push(current); }
        var sname = hasSrc ? r.src : (realTime ? lastSrcName : '');
        if (hasSrc) lastSrcName = r.src;
        if (sname) srcEntries(sname, r.time).forEach(function(e) { current.sources.push(e); });
      }
    });

    // Re-apply manual bind overrides (from the bind-source modal) so a chosen clip
    // survives a re-parse (validate / refresh / voice-align rebuild from the sheet).
    blocks.forEach(function(b) {
      (b.sources || []).forEach(function(s) {
        s._orig = s.name; // keep the true sheet name as the override key
        var ov = sacBindOverrides[sacNorm(s.name)];
        if (ov) s.name = ov;
      });
    });

    return blocks;
  }

  // ── Block preview ───────────────────────────────────────────────────────
  var BLOCK_COLORS = ['#a855f7','#f59e0b','#10b981','#3b82f6','#ef4444','#ec4899'];
  var BLOCK_BG     = ['rgba(168,85,247,0.12)','rgba(245,158,11,0.1)','rgba(16,185,129,0.1)',
                      'rgba(59,130,246,0.1)','rgba(239,68,68,0.1)','rgba(236,72,153,0.1)'];

  function renderBlocks(blocks) {
    var list = $('sacBlockList');
    list.innerHTML = '';
    $('sacBlockCount').textContent = blocks.length + ' block' + (blocks.length !== 1 ? 's' : '');

    // Carry over per-source UI state (skip flag) from the previously rendered
    // blocks, matched by position + name. Without this, a re-render (e.g. when
    // aligning voice after the user marked some sources Skip) would reset the
    // flags → a skipped source would get cut with a clip instead of a gap (bug #5).
    var _prevBlocks = parsedBlocks || [];
    blocks.forEach(function(nb, bi) {
      var pb = _prevBlocks[bi];
      if (!pb || !pb.sources) return;
      (nb.sources || []).forEach(function(ns, si) {
        var ps = pb.sources[si];
        if (ps && ps.skipped && sacNorm(ps.name) === sacNorm(ns.name)) ns.skipped = true;
      });
    });

    blocks.forEach(function(block, i) {
      var color = BLOCK_COLORS[i % BLOCK_COLORS.length];
      var bg    = BLOCK_BG[i % BLOCK_BG.length];

      var card = document.createElement('div');
      card.className = 'sac-blockCard';

      // Header (click to collapse/expand)
      var header = document.createElement('div');
      header.className = 'sac-blockCardHeader';
      header.style.color = color;
      header.style.background = bg;

      var chevron = document.createElement('span');
      chevron.className = 'sac-blockChevron';
      chevron.textContent = '▾';
      header.appendChild(chevron);

      var label = document.createElement('span');
      label.textContent = 'Block ' + (i + 1)
        + '  ·  ' + block.texts.length + ' text'
        + (block.texts.length !== 1 ? 's' : '')
        + '  ·  ' + block.sources.length + ' source'
        + (block.sources.length !== 1 ? 's' : '');
      header.appendChild(label);

      // Voice duration badge — filled in by sacAlignVoice() after alignment
      var voiceBadge = document.createElement('span');
      voiceBadge.className = 'sac-blockVoiceBadge';
      voiceBadge.dataset.blockIdx = String(i);
      header.appendChild(voiceBadge);

      card.appendChild(header);

      // Body
      var body = document.createElement('div');
      body.className = 'sac-blockCardBody';

      header.addEventListener('click', function() {
        var collapsed = body.style.display === 'none';
        body.style.display = collapsed ? '' : 'none';
        chevron.textContent = collapsed ? '▾' : '▸';
      });

      block.texts.forEach(function(t) {
        var el = document.createElement('div');
        el.className = 'sac-blockText';
        sacLabelIcon(el, 'comment_dots', '#64748b', 11, t);
        body.appendChild(el);
      });

      if (block.texts.length > 0 && block.sources.length > 0) {
        var div = document.createElement('div');
        div.className = 'sac-blockDivider';
        body.appendChild(div);
      }

      block.sources.forEach(function(s, si) {
        var el = document.createElement('div');
        el.className = 'sac-blockSrc';
        el.dataset.srcName  = s.name;
        el.dataset.blockIdx = String(i);
        el.dataset.srcIdx   = String(si);
        var nameSpan = document.createElement('span');
        nameSpan.className = 'sac-srcName';
        sacLabelIcon(nameSpan, 'video', '#94a3b8', 12, s.name);
        el.appendChild(nameSpan);
        if (s.time) {
          var badge = document.createElement('span');
          badge.className = 'sac-blockTimeBadge';
          // Show a clean timecode (e.g. "giây 18-19" → "0:18-0:19"); falls back to
          // the raw text if it has no parseable time. Display only — s.time (the cut
          // source) is untouched, so the actual cut is unchanged.
          badge.textContent = sacFmtTimeBadge(s.time);
          el.appendChild(badge);
        }
        // 📁 folder hint button — lets user fix source name from block card
        (function(srcEl, bIdx, sIdx) {
          var hintBtn = document.createElement('div');
          hintBtn.setAttribute('role', 'button');
          hintBtn.className = 'sac-blockHintBtn';
          piSetBtn(hintBtn, 'folder', null, null, 11);
          hintBtn.setAttribute('data-tip', 'Gợi ý folder hint');
          hintBtn.style.display = 'none'; // shown after validate (✗ or ⚠)
          hintBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            sacShowBlockFolderHints(srcEl, bIdx, sIdx);
          });
          srcEl.appendChild(hintBtn);
          // ↩ unbind — revert an accidental bind back to the original sheet name.
          var unbindBtn = document.createElement('div');
          unbindBtn.setAttribute('role', 'button');
          unbindBtn.className = 'sac-blockUnbindBtn';
          piSetBtn(unbindBtn, 'rotate_left', null, null, 11);
          unbindBtn.setAttribute('data-tip', 'Bỏ bind — về tên gốc');
          unbindBtn.style.display = sacBindOverrides[sacNorm(s._orig || s.name)] ? '' : 'none';
          unbindBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            sacUnbindSource(srcEl, bIdx, sIdx);
          });
          srcEl.appendChild(unbindBtn);
        })(el, i, si);
        var statusSpan = document.createElement('span');
        statusSpan.className = 'sac-srcStatus';
        statusSpan.textContent = '⌛';
        el.appendChild(statusSpan);
        // Inline per-source problem message (shown next to this source, not in the
        // global status line).
        var msgSpan = document.createElement('span');
        msgSpan.className = 'sac-srcMsg';
        el.appendChild(msgSpan);
        body.appendChild(el);
      });

      card.appendChild(body);
      list.appendChild(card);
    });

    parsedBlocks = blocks;
    $('sacBlockSection').style.display = 'flex';
    // Re-rendering invalidates both gates — must re-validate + re-align.
    sacValidatePassed = false;
    sacVoiceReady = false;
    sacHideCutPanel();
  }

  // ── Source validation (Phase 3) ─────────────────────────────────────────
  // Updates the ✓/✗ icons on each source row. Returns a promise resolving to
  // { missing: [names], premiereAvailable: bool }.
  async function sacValidateSources(blocks) {
    var names = [];
    blocks.forEach(function(b) {
      b.sources.forEach(function(s) {
        if (s.name && names.indexOf(s.name) === -1) names.push(s.name);
      });
    });
    if (names.length === 0) return { missing: [], premiereAvailable: true };

    sacSourceMap = {};

    var rootItem = null;
    try {
      var proj = await getActiveProject();
      if (typeof proj.getRootItem === 'function') {
        rootItem = proj.getRootItem();
        if (rootItem && typeof rootItem.then === 'function') rootItem = await rootItem;
      }
      if (!rootItem) rootItem = proj.rootItem || null; // legacy fallback
    } catch(e) {
      // Not running inside Premiere — clear spinners (dev mode, can't verify bin)
      document.querySelectorAll('.sac-srcStatus').forEach(function(el) { el.textContent = ''; });
      return { missing: [], premiereAvailable: false };
    }

    // One full traversal; persist for hint UI; log for debugging.
    var binItems = rootItem ? (await sacCollectBinItems(rootItem)) : [];
    sacBinItems = binItems; // persist so 📁 button can suggest folders later
    console.log('[SAC] Bin items found (' + binItems.length + '):',
      binItems.map(function(b) { return b.name; }));

    // Detect ambiguous names: same plain name matches 2+ distinct bin clips.
    // NOTE: only warns for names without a folder hint already (no spaces / single token).
    var ambiguousNames = {};
    names.forEach(function(name) {
      var count = sacCountBinMatches(binItems, name);
      if (count > 1) ambiguousNames[name] = count;
    });

    var allRows = document.querySelectorAll('.sac-blockSrc');
    console.log('[SAC validate] names:', names, '| DOM rows found:', allRows.length);
    allRows.forEach(function(el) {
      console.log('[SAC validate] row srcName="' + el.dataset.srcName + '" blockIdx=' + el.dataset.blockIdx);
    });

    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var item = sacMatchBinItem(binItems, name);
      sacSourceMap[name] = item || null;
      var isAmbiguous = !!ambiguousNames[name];
      console.log('[SAC validate] "' + name + '" →', item ? '✓ found' : '✗ missing', '| ambiguous:', isAmbiguous);

      // Update every source row with this name (may appear in multiple blocks)
      document.querySelectorAll('.sac-blockSrc').forEach(function(el) {
        if (el.dataset.srcName !== name) return;
        var statusEl = el.querySelector('.sac-srcStatus');
        console.log('[SAC validate] updating row "' + name + '" → statusEl:', statusEl ? 'found' : 'NULL');
        if (!statusEl) return;
        // Priority: ⚠ ambiguous > ✓ found > ✗ missing
        // Even if item was found, if ambiguous we must warn — Pass1+2 found multiple
        // matches so the resolved item might be wrong. User must add folder hint.
        // Remove stale Skip button if source is now found/resolved
        var existingSkip = el.querySelector('.sac-skipBtn');
        var hintBtn = el.querySelector('.sac-blockHintBtn');
        var msgEl  = el.querySelector('.sac-srcMsg');
        if (isAmbiguous) {
          el.dataset.srcBaseKind = 'ambiguous';            // base state for skip/undo restore
          el.dataset.srcBaseCount = String(ambiguousNames[name]);
          statusEl.className = 'sac-srcStatus sac-srcAmbiguous';
          statusEl.textContent = '⚠';
          statusEl.title = ambiguousNames[name] + ' clips trùng tên — cần folder hint (📁)';
          if (hintBtn) hintBtn.style.display = '';
          if (msgEl) { msgEl.innerHTML = '⚠ trùng ' + sacEsc(ambiguousNames[name]) + ' clip — bấm ' + sacFolderIco() + ' để chọn'; msgEl.className = 'sac-srcMsg is-warn'; }
          sacAddSkipButton(el);
        } else if (sacSourceMap[name]) {  // found ✓
          el.dataset.srcBaseKind = 'found';
          statusEl.className = 'sac-srcStatus sac-srcOk';
          statusEl.textContent = '✓ Match';
          if (hintBtn) hintBtn.style.display = '';  // keep 📁 so a matched source can be re-bound (e.g. reuse a clip that already has effects)
          sacSetMatchMsg(msgEl, sacSourceMap[name]); // show …/folder/clip it matched
          if (existingSkip) existingSkip.parentNode.removeChild(existingSkip);
        } else {  // missing ✗
          el.dataset.srcBaseKind = 'missing';
          statusEl.className = 'sac-srcStatus sac-srcMissing';
          statusEl.textContent = '✗';
          if (hintBtn) hintBtn.style.display = '';
          if (msgEl) { msgEl.innerHTML = '✗ không thấy trong bin — ' + sacFolderIco() + ' hoặc Skip'; msgEl.className = 'sac-srcMsg is-err'; }
          sacAddSkipButton(el);
        }
      });
    }

    var missingNames = names.filter(function(n) { return !sacSourceMap[n]; });
    console.log('[SAC] Bin scan: ' + binItems.length + ' item (clip+folder).');
    // For each missing source, show the normalized target + the closest items
    // actually in the scan (name + normalized + edit distance), so it's obvious
    // whether the clip is even in the scan and why it didn't match.
    missingNames.forEach(function(mn) {
      var tN = sacNorm(mn);
      var ranked = binItems.filter(function(b) { return !b.isFolder; }).map(function(b) {
        return { full: (b.parent ? b.parent + '/' : '') + b.name, norm: sacNorm(b.name), d: sacLev(tN, sacNorm(b.name.replace(/\.[^.]+$/, ''))) };
      }).sort(function(a, b) { return a.d - b.d; }).slice(0, 6);
      console.log('[SAC] "' + mn + '" (norm="' + tN + '") KHÔNG khớp. 6 clip gần nhất trong bin:',
        ranked.map(function(r) { return r.full + ' [norm="' + r.norm + '", d=' + r.d + ']'; }));
    });

    // ambiguousNames đã là object {name→count} từ đầu hàm, chuyển sang array để return
    var ambiguousArray = Object.keys(ambiguousNames);

    window.sacSourceMap = sacSourceMap; // expose for Phase 5 assembly
    return { missing: missingNames, ambiguous: ambiguousArray, premiereAvailable: true };
  }

  // ── Block card folder hint ───────────────────────────────────────────────────
  // Shows candidate folder-prefixed names for a ✗/⚠ source row.
  // Clicking a candidate: updates parsedBlocks source name + re-validates that source.
  // Revert an accidental bind: drop the override, restore the original sheet name,
  // re-match against the bin, and refresh the row's status / buttons.
  // Apply the "bound to a chosen clip" visual state to one source row element.
  // Shared by bindTo (clicked row + same-name siblings) so propagation looks uniform.
  function sacApplyBoundVisual(srcEl, label, item) {
    srcEl.dataset.srcName = label;
    var nameSpan = srcEl.querySelector('.sac-srcName');
    if (nameSpan) { sacLabelIcon(nameSpan, 'video', '#94a3b8', 12, label); nameSpan.style.opacity = ''; nameSpan.style.textDecoration = ''; }
    var skipBtn = srcEl.querySelector('.sac-skipBtn');
    if (skipBtn) skipBtn.parentNode.removeChild(skipBtn);
    srcEl.dataset.srcBaseKind = item ? 'found' : 'missing';
    var msg = srcEl.querySelector('.sac-srcMsg');
    if (msg) {
      if (item) sacSetMatchMsg(msg, item);
      else { msg.textContent = '✗ vẫn không thấy'; msg.className = 'sac-srcMsg is-err'; }
    }
    var statusEl = srcEl.querySelector('.sac-srcStatus');
    if (statusEl) {
      if (item) { statusEl.className = 'sac-srcStatus sac-srcOk'; statusEl.textContent = '✓ Match'; }
      else { statusEl.className = 'sac-srcStatus sac-srcMissing'; statusEl.textContent = '✗'; sacAddSkipButton(srcEl); }
    }
    var hintBtn = srcEl.querySelector('.sac-blockHintBtn');
    if (hintBtn) hintBtn.style.display = ''; // keep 📁 so a wrong bind can be re-bound
    var ub = srcEl.querySelector('.sac-blockUnbindBtn');
    if (ub) ub.style.display = ''; // bound → allow undo (↩)
  }

  function sacUnbindSource(srcEl, bIdx, sIdx) {
    var src = parsedBlocks[bIdx] && parsedBlocks[bIdx].sources[sIdx];
    if (!src) return;
    var orig = src._orig || src.name;
    var bindKey = sacNorm(orig);
    delete sacBindOverrides[bindKey];
    sacForgetBind(bindKey); // drop the persisted project bind too
    src.name = orig;
    src.skipped = false;

    // Replicate validate's per-row status exactly (⚠ ambiguous > ✓ found > ✗ missing),
    // so unbinding truly restores the original state — not a false ✓ from the first match.
    var count = sacCountBinMatches(sacBinItems, orig);
    var item  = sacMatchBinItem(sacBinItems, orig);
    var isAmbiguous = count > 1;
    sacSourceMap[orig] = item || null;
    window.sacSourceMap = sacSourceMap;

    // Unbind propagates to every occurrence of the same source (mirror of bindTo).
    parsedBlocks.forEach(function(b) {
      (b.sources || []).forEach(function(s) {
        if (sacNorm(s._orig || s.name) === bindKey) { s.name = orig; s.skipped = false; }
      });
    });
    var _siblings = [];
    document.querySelectorAll('#sacBlockList .sac-blockSrc').forEach(function(rEl) {
      if (rEl === srcEl) return;
      var sm = parsedBlocks[+rEl.dataset.blockIdx] && parsedBlocks[+rEl.dataset.blockIdx].sources[+rEl.dataset.srcIdx];
      if (sm && sacNorm(sm._orig || sm.name) === bindKey) _siblings.push(rEl);
    });

    // Restore one row to its pre-bind status (applied to clicked row + siblings).
    function restoreRow(rEl) {
      rEl.dataset.srcName = orig;
      var nameSpan = rEl.querySelector('.sac-srcName');
      if (nameSpan) { sacLabelIcon(nameSpan, 'video', '#94a3b8', 12, orig); nameSpan.style.opacity = ''; nameSpan.style.textDecoration = ''; }
      var statusEl = rEl.querySelector('.sac-srcStatus');
      var hintBtn  = rEl.querySelector('.sac-blockHintBtn');
      var oldSkip  = rEl.querySelector('.sac-skipBtn');
      var uMsg     = rEl.querySelector('.sac-srcMsg');
      if (oldSkip) oldSkip.parentNode.removeChild(oldSkip);
      rEl.dataset.srcBaseKind = isAmbiguous ? 'ambiguous' : (item ? 'found' : 'missing');
      if (isAmbiguous) rEl.dataset.srcBaseCount = String(count);
      if (statusEl) {
        if (isAmbiguous) {
          statusEl.className = 'sac-srcStatus sac-srcAmbiguous'; statusEl.textContent = '⚠';
          statusEl.title = count + ' clips trùng tên — cần folder hint (📁)';
          if (hintBtn) hintBtn.style.display = '';
          if (uMsg) { uMsg.innerHTML = '⚠ trùng ' + sacEsc(count) + ' clip — bấm ' + sacFolderIco() + ' để chọn'; uMsg.className = 'sac-srcMsg is-warn'; }
          sacAddSkipButton(rEl);
        } else if (item) {
          statusEl.className = 'sac-srcStatus sac-srcOk'; statusEl.textContent = '✓ Match'; statusEl.title = '';
          if (hintBtn) hintBtn.style.display = '';  // keep 📁 so a matched source can still be re-bound
          sacSetMatchMsg(uMsg, item); // show …/folder/clip it matched
        } else {
          statusEl.className = 'sac-srcStatus sac-srcMissing'; statusEl.textContent = '✗'; statusEl.title = '';
          if (hintBtn) hintBtn.style.display = '';
          if (uMsg) { uMsg.innerHTML = '✗ không thấy trong bin — ' + sacFolderIco() + ' hoặc Skip'; uMsg.className = 'sac-srcMsg is-err'; }
          sacAddSkipButton(rEl);
        }
      }
      var ub = rEl.querySelector('.sac-blockUnbindBtn');
      if (ub) ub.style.display = 'none';
    }
    restoreRow(srcEl);
    _siblings.forEach(restoreRow);
    // No longer fully resolved → require a re-validate before Run.
    if (isAmbiguous || !item) { sacValidatePassed = false; if (typeof sacUpdateRunVisibility === 'function') sacUpdateRunVisibility(); }
    sacCheckSkipGate();
  }

  // Open the 2-column bind-source modal (📁 Folder | 🎬 Source) for one source row.
  function sacShowBlockFolderHints(srcEl, bIdx, sIdx) {
    var modal     = $('sacBindModal');
    var foldersEl = $('sacBindFolders');
    var sourcesEl = $('sacBindSources');
    var filterEl  = $('sacBindFilter');
    var titleEl   = $('sacBindTitle');
    if (!modal || !foldersEl || !sourcesEl) return;

    if (!sacBinItems.length) {
      $('sacStatus').textContent = '⚠ Bấm Validate trước để load danh sách bin.';
      $('sacStatus').style.display = 'block';
      return;
    }
    var src = parsedBlocks[bIdx] && parsedBlocks[bIdx].sources[sIdx];
    if (!src) return;
    titleEl.textContent = 'Chọn source cho "' + src.name + '"';

    // Rank ALL clips by closeness to the source name (token hits, then edit distance),
    // so the right clip is near the top instead of dumping every loose token match.
    var tNoX = sacNorm(src.name);
    var toks = tNoX.split(' ').filter(function(t) { return t.length >= 2 || /^[0-9]+$/.test(t); });
    // Pure-number source name ("1","2",…): plain token match is too loose because
    // sacNorm splits decimals ("5.1"→"5 1", "1.2"→"1 2") so every "X.1" / "1.x" clip
    // gains a "1" token. Instead require the clip NAME to start with exactly that
    // number followed by a separator (space / _ / -) or end → matches "1", "1 abc",
    // "1_abc", "1-abc", "1.gif" but NOT "5.1" / "1.2" / "10.1" / "1.0clone".
    var srcNum = (toks.length === 1 && /^[0-9]+$/.test(toks[0])) ? toks[0] : null;
    var numRe  = srcNum ? new RegExp('^' + srcNum + '([\\s_-]|$)') : null;
    var TOP_N = 25; // default visible count when not filtering
    function toCand(b) {
      var clipNoX = b.name.replace(/\.[^.]+$/, '');
      // WHOLE-TOKEN match (not substring): token "12" matches a clip token "12",
      // NOT "123" / "12abcd". hits also counts folder-path tokens (folder hints).
      var hayToks  = sacNorm((b.path || '') + ' ' + b.name).split(' ').filter(Boolean);
      var nameToks = sacNorm(b.name).split(' ').filter(Boolean);
      var hits     = toks.filter(function(tk) { return hayToks.indexOf(tk)  !== -1; }).length;
      var nameHits = toks.filter(function(tk) { return nameToks.indexOf(tk) !== -1; }).length;
      var coverage = nameHits / Math.max(1, nameToks.length);
      var lev = sacLev(tNoX, sacNorm(clipNoX));
      // leadNum: clip name (real media ext stripped) starts with the numeric source.
      var leadNum = numRe ? numRe.test(dispName(b.name).trim()) : false;
      return { folder: b.parent || '', folderPath: b.path || '', clip: b.name, clipNoX: clipNoX,
               item: b.item, coverage: coverage, score: hits * 1000 + Math.round(coverage * 100) - lev, hits: hits, leadNum: leadNum, mediaType: b.mediaType || 'other' };
    }
    var cands = sacBinItems.filter(function(b) { return !b.isFolder; }).map(toCand)
      .sort(function(a, b) { return b.score - a.score; });
    var relevant;
    if (srcNum) {
      // Numeric source → only clips whose name leads with that exact number.
      relevant = cands.filter(function(c) { return c.leadNum; });
    } else {
      // Share a whole token AND that match covers a real part of the clip name
      // (coverage ≥ 0.34) so a short token doesn't pull in incidental matches.
      relevant = cands.filter(function(c) { return c.hits > 0 && c.coverage >= 0.34; });
      if (!relevant.length) relevant = cands.filter(function(c) { return c.hits > 0; });
    }
    if (!relevant.length) relevant = cands;
    // Build a folder TREE (each path + its ancestors) from a clip array.
    function buildFolders(arr) {
      var set = {};
      arr.forEach(function(c) {
        var segs = c.folderPath ? c.folderPath.split(' / ') : [];
        for (var d = 1; d <= segs.length; d++) set[segs.slice(0, d).join(' / ')] = true;
      });
      return Object.keys(set).sort();
    }
    var relevantFolders = buildFolders(relevant);  // default: only folders of matching clips
    var allFolders      = buildFolders(cands);      // "show all" → every folder in the bin
    var showAllFolders  = false;
    function topFoldersNow() { return showAllFolders ? allFolders : relevantFolders; }

    var selectedFolder = '__all__'; // holds a folderPath, or '__all__'
    var typeFilter = 'all';          // 'all' | 'video' | 'audio' | 'image' | 'sequence'
    var _theSrc0 = parsedBlocks[bIdx] && parsedBlocks[bIdx].sources[sIdx];
    var boundItem = _theSrc0 ? sacSourceMap[_theSrc0.name] : null; // clip the source currently binds to
    var expanded = {};               // folderPath -> true; empty = all collapsed (default)
    function fHasChildren(fp) { return topFoldersNow().some(function(o) { return o.indexOf(fp + ' / ') === 0; }); }
    function fParent(fp) { var s = fp.split(' / '); return s.length > 1 ? s.slice(0, -1).join(' / ') : null; }
    function fVisible(fp) { var p = fParent(fp); while (p) { if (!expanded[p]) return false; p = fParent(p); } return true; }

    // Strip only real media extensions for display (NOT arbitrary dots in the name).
    function dispName(n) { return String(n).replace(/\.(mov|mp4|mxf|mkv|avi|m4v|mpg|mpeg|wav|mp3|m4a|aac|flac|ogg|gif|png|jpg|jpeg|tif|tiff|psd|prproj)$/i, ''); }

    function renderFolders() {
      foldersEl.innerHTML = '';
      var all = document.createElement('div');
      all.className = 'sac-bind-row' + (selectedFolder === '__all__' ? ' is-active' : '');
      all.style.paddingLeft = '8px';
      all.appendChild(sacIconEl('folder'));
      var allTxt = document.createElement('span'); allTxt.textContent = ' Tất cả'; all.appendChild(allTxt);
      all.addEventListener('click', function() { selectedFolder = '__all__'; renderFolders(); renderSources(); });
      foldersEl.appendChild(all);
      // Collapsible tree: a folder shows only when all its ancestors are expanded
      // (default: everything collapsed → only top-level folders visible). A caret
      // toggles expand; clicking the name selects the folder.
      topFoldersNow().forEach(function(fp) {
        if (!fVisible(fp)) return;
        var segs = fp.split(' / ');
        var leaf = segs[segs.length - 1];
        var kids = fHasChildren(fp);
        var row = document.createElement('div');
        row.className = 'sac-bind-row' + (selectedFolder === fp ? ' is-active' : '');
        row.style.paddingLeft = (8 + (segs.length - 1) * 16) + 'px';
        row.title = fp;
        var caret = document.createElement('span');
        caret.className = 'sac-bind-caret';
        caret.textContent = kids ? (expanded[fp] ? '▾' : '▸') : '';
        if (kids) caret.addEventListener('click', function(e) { e.stopPropagation(); expanded[fp] = !expanded[fp]; renderFolders(); });
        var lbl = document.createElement('span');
        lbl.className = 'sac-bind-fLbl';
        lbl.appendChild(sacIconEl('folder'));
        var lt = document.createElement('span'); lt.textContent = ' ' + leaf; lbl.appendChild(lt);
        row.appendChild(caret); row.appendChild(lbl);
        row.addEventListener('click', function() { selectedFolder = fp; renderFolders(); renderSources(); });
        foldersEl.appendChild(row);
      });
    }
    // Type-filter chips (only show types actually present in the pool).
    function renderTypeChips() {
      var el = $('sacBindTypeChips'); if (!el) return;
      el.innerHTML = '';
      var present = {};
      (showAllFolders ? cands : relevant).forEach(function(c) { present[c.mediaType] = true; });
      ['all', 'video', 'audio', 'image', 'sequence'].forEach(function(t) {
        if (t !== 'all' && !present[t]) return;
        var chip = document.createElement('span');
        chip.className = 'sac-bind-chip' + (typeFilter === t ? ' is-active' : '');
        if (t === 'all') chip.textContent = 'Tất cả';
        else chip.appendChild(sacIconEl(t));
        chip.addEventListener('click', function() { typeFilter = t; renderTypeChips(); renderSources(); });
        el.appendChild(chip);
      });
    }
    function renderSources() {
      renderTypeChips();
      sourcesEl.innerHTML = '';
      var q = sacNorm(filterEl.value || '');
      // Default pool = relevant (token-matching) clips. Typing OR "show all folders"
      // widens the pool to ALL clips so any folder's sources are browsable.
      var pool = (q || showAllFolders) ? cands : relevant;
      var base = pool.filter(function(c) {
        // Selecting a branch shows clips in it AND in its sub-folders.
        if (selectedFolder !== '__all__' &&
            !(c.folderPath === selectedFolder || c.folderPath.indexOf(selectedFolder + ' / ') === 0)) return false;
        if (typeFilter !== 'all' && c.mediaType !== typeFilter) return false;
        if (q && sacNorm(c.folderPath + ' ' + c.clip).indexOf(q) === -1) return false;
        return true;
      });
      if (!base.length) { var n = document.createElement('div'); n.className = 'sac-bind-none'; n.textContent = '— không có —'; sourcesEl.appendChild(n); return; }
      // Keep the single best-scoring match on top (pool is score-sorted → base[0]),
      // then order the remainder naturally (A→Z, 1→99) for a stable, scannable list.
      if (base.length > 1) {
        base = [base[0]].concat(base.slice(1).sort(function(a, b) {
          return sacNatCmp(dispName(a.clip), dispName(b.clip));
        }));
      }
      // When not filtering/picking, show only the closest TOP_N so the list isn't overwhelming.
      var showAll = !!q || selectedFolder !== '__all__' || typeFilter !== 'all';
      var rows = showAll ? base : base.slice(0, TOP_N);
      rows.forEach(function(c) {
        var isBound = boundItem && c.item === boundItem;
        var row = document.createElement('div');
        row.className = 'sac-bind-row sac-bind-srcRow' + (isBound ? ' is-bound' : '');
        row.title = (c.folderPath ? c.folderPath + ' / ' : '') + c.clip;
        var top = document.createElement('div');
        top.className = 'sac-bind-srcTop';
        top.appendChild(sacIconEl(c.mediaType));
        var nm = document.createElement('span');
        nm.textContent = dispName(c.clip) + (isBound ? '   ✓ đang chọn' : '');
        top.appendChild(nm);
        row.appendChild(top);
        if (c.folderPath) {
          var p = document.createElement('div');
          p.className = 'sac-bind-srcPath';
          p.textContent = c.folderPath;
          row.appendChild(p);
        }
        row.addEventListener('click', function() { bindTo(c); });
        sourcesEl.appendChild(row);
      });
      if (!showAll && base.length > TOP_N) {
        var more = document.createElement('div');
        more.className = 'sac-bind-none';
        more.textContent = '+ ' + (base.length - TOP_N) + ' nữa — gõ để lọc';
        sourcesEl.appendChild(more);
      }
    }
    function bindTo(c) {
      // Use the full display name (media ext stripped only) so the bound name isn't
      // truncated at an arbitrary dot. Folder leaf prefix keeps Pass-3 re-match working.
      var clipDisp = dispName(c.clip);
      var label = c.folder ? (c.folder + ' ' + clipDisp) : clipDisp;
      var theSrc = parsedBlocks[bIdx].sources[sIdx];
      // Record override keyed by the ORIGINAL sheet name so it survives re-parse,
      // and persist it for the open project so future tasks re-use this bind.
      var bindKey = sacNorm(theSrc._orig || theSrc.name);
      sacBindOverrides[bindKey] = label;
      sacPersistBind(bindKey, label);
      // Bind directly to the chosen clip — no name re-matching needed (robust).
      sacSourceMap[label] = c.item || null;
      window.sacSourceMap = sacSourceMap;
      // Propagate to EVERY source sharing this original name: bind one of the same
      // source → all its other occurrences (different times/blocks) auto-resolve too.
      parsedBlocks.forEach(function(b) {
        (b.sources || []).forEach(function(s) {
          if (sacNorm(s._orig || s.name) === bindKey) { s.name = label; s.skipped = false; }
        });
      });
      document.querySelectorAll('#sacBlockList .sac-blockSrc').forEach(function(rEl) {
        var sm = parsedBlocks[+rEl.dataset.blockIdx] && parsedBlocks[+rEl.dataset.blockIdx].sources[+rEl.dataset.srcIdx];
        if (sm && sacNorm(sm._orig || sm.name) === bindKey) sacApplyBoundVisual(rEl, label, c.item);
      });
      sacCheckSkipGate();
      closeModal();
    }
    function onFilter() { renderSources(); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeModal(); } }
    // Remember the block list's scroll so binding doesn't jump it to the top
    // (hiding/showing .sac-app resets the inner scroll container).
    var blockList = $('sacBlockList');
    var savedScroll = blockList ? blockList.scrollTop : 0;
    function closeModal() {
      modal.hidden = true;
      var app = document.querySelector('#tab-autocut .sac-app');
      if (app) app.style.display = '';
      if (blockList) setTimeout(function() { try { blockList.scrollTop = savedScroll; } catch(e) {} }, 0);
      if (window.releaseKeyboard) window.releaseKeyboard();
      filterEl.removeEventListener('input', onFilter);
      filterEl.removeEventListener('keydown', onKey);
      var cb = $('sacBindClose'); if (cb) cb.onclick = null;
    }

    // Open
    filterEl.value = '';
    // "Show all folders" checkbox — default off (only folders of matching clips).
    var allFoldersChk = $('sacBindAllFolders');
    if (allFoldersChk) {
      allFoldersChk.checked = false;
      allFoldersChk.onchange = function() { showAllFolders = allFoldersChk.checked; expanded = {}; renderFolders(); };
    }
    renderFolders();
    renderSources();
    var app = document.querySelector('#tab-autocut .sac-app');
    if (app) app.style.display = 'none'; // hide background (UXP native inputs paint on top)
    modal.hidden = false;
    var cb = $('sacBindClose'); if (cb) cb.onclick = closeModal;
    filterEl.addEventListener('input', onFilter);
    filterEl.addEventListener('keydown', onKey);
    try { filterEl.focus(); } catch(e) {}
    if (window.claimKeyboard) window.claimKeyboard();
  }

  // ── Skip source button ──────────────────────────────────────────────────────
  // Appears on source rows with ✗ validation. Marks the source as skipped so
  // assembly replaces it with a 1s gap instead of a real clip.
  function sacAddSkipButton(srcEl) {
    if (srcEl.querySelector('.sac-skipBtn')) return; // already added
    var btn = document.createElement('div');
    btn.setAttribute('role', 'button');
    btn.className = 'sac-skipBtn';

    // Paint the row to reflect the current skipped state (so a re-render of an
    // already-skipped source shows the right state, not a stale "Skip").
    function applyState() {
      var bIdx = parseInt(srcEl.dataset.blockIdx, 10);
      var sIdx = parseInt(srcEl.dataset.srcIdx,   10);
      var src  = parsedBlocks[bIdx] && parsedBlocks[bIdx].sources[sIdx];
      var skipped = !!(src && src.skipped);
      var statusEl = srcEl.querySelector('.sac-srcStatus');
      var nameSpan = srcEl.querySelector('.sac-srcName');
      var msgEl    = srcEl.querySelector('.sac-srcMsg');
      if (skipped) {
        sacLabelIcon(btn, 'rotate_left', null, 11, 'Bỏ skip');
        btn.classList.add('is-active');
        srcEl.classList.add('is-skipped');
        if (statusEl) { statusEl.textContent = '⏭'; statusEl.className = 'sac-srcStatus sac-srcSkipped'; statusEl.title = 'Đã bỏ qua — chèn gap'; }
        if (nameSpan)  { nameSpan.style.opacity = '0.4'; nameSpan.style.textDecoration = 'line-through'; }
        if (msgEl)     { msgEl.textContent = '⏭ ĐÃ BỎ QUA — chèn 1s gap, không cắt source này'; msgEl.className = 'sac-srcMsg is-skip'; }
      } else {
        btn.textContent = 'Skip';
        btn.classList.remove('is-active');
        srcEl.classList.remove('is-skipped');
        if (nameSpan)  { nameSpan.style.opacity = ''; nameSpan.style.textDecoration = ''; }
        // Restore the underlying status — ambiguous (⚠) vs missing (✗) — instead of
        // always showing "không thấy" (which wrongly clobbered ⚠ duplicate-name rows).
        var kind = srcEl.dataset.srcBaseKind || 'missing';
        if (kind === 'ambiguous') {
          var cnt = srcEl.dataset.srcBaseCount || '';
          if (statusEl) { statusEl.textContent = '⚠'; statusEl.className = 'sac-srcStatus sac-srcAmbiguous'; statusEl.title = cnt + ' clip trùng tên — bấm 📁'; }
          if (msgEl)    { msgEl.innerHTML = '⚠ trùng ' + sacEsc(cnt) + ' clip — bấm ' + sacFolderIco() + ' để chọn'; msgEl.className = 'sac-srcMsg is-warn'; }
        } else {
          if (statusEl) { statusEl.textContent = '✗'; statusEl.className = 'sac-srcStatus sac-srcMissing'; statusEl.title = ''; }
          if (msgEl)    { msgEl.innerHTML = '✗ không thấy trong bin — ' + sacFolderIco() + ' hoặc Skip'; msgEl.className = 'sac-srcMsg is-err'; }
        }
      }
    }

    btn.addEventListener('click', function() {
      var bIdx = parseInt(srcEl.dataset.blockIdx, 10);
      var sIdx = parseInt(srcEl.dataset.srcIdx,   10);
      var src  = parsedBlocks[bIdx] && parsedBlocks[bIdx].sources[sIdx];
      if (!src) return;
      src.skipped = !src.skipped;
      applyState();
      sacCheckSkipGate(); // all missing now skipped → open Run gate
    });
    // Insert BEFORE the status glyph (which has margin-left:auto, so it floats to the
    // far right) — keeps Skip in the left cluster next to the folder/unbind buttons.
    var statusRef = srcEl.querySelector('.sac-srcStatus');
    if (statusRef) srcEl.insertBefore(btn, statusRef); else srcEl.appendChild(btn);
    applyState(); // reflect current state on creation (handles carried-over skip)
  }

  // After each skip toggle: if every missing source is now skipped, pass the
  // validate gate so the Run button appears (skipped sources → 1s gap in assembly).
  function sacCheckSkipGate() {
    if (!parsedBlocks.length) return;
    var allResolved = parsedBlocks.every(function(block) {
      return (block.sources || []).every(function(src) {
        return !!(sacSourceMap[src.name]) || !!src.skipped;
      });
    });
    if (allResolved) {
      sacValidatePassed = true;
      var st = $('sacStatus');
      if (st) {
        st.textContent = '✅ Tất cả sources đã resolved (validate ✓ hoặc skip ⏭).';
        st.style.display = 'block';
      }
    } else {
      sacValidatePassed = false;
    }
    sacUpdateRunVisibility();
  }

  // ── Folder hint UI ─────────────────────────────────────────────────────────
  // Shows folder options (from last bin scan) in the status area so user can
  // prepend the right folder to disambiguate a source name.
  function sacShowFolderHints(srcName, inputEl) {
    var statusEl = $('sacStatus');
    if (!srcName) {
      statusEl.textContent = '⚠ Nhập tên source trước khi chọn folder hint.';
      statusEl.style.display = 'block'; return;
    }
    if (!sacBinItems.length) {
      statusEl.innerHTML = '⚠ Bấm Validate trước để load danh sách bin — sau đó bấm ' + sacFolderIco() + ' lại.';
      statusEl.style.display = 'block'; return;
    }

    // Collect all bin items that match this source name (Pass 1+2 only)
    var t = sacNorm(srcName), tNoX = t.replace(/\.[^.]+$/, '');
    var matches = sacBinItems.filter(function(b) {
      var cn = sacNorm(b.name), cnNoX = cn.replace(/\.[^.]+$/, '');
      if (cn === t || cnNoX === t || cn === tNoX || cnNoX === tNoX) return true;
      if (tNoX && cn.indexOf(tNoX) === 0) {
        var nx = cn.charAt(tNoX.length);
        if (nx === '' || /[\s._\-]/.test(nx)) return true;
      }
      return false;
    });

    if (!matches.length) {
      statusEl.textContent = '⚠ "' + srcName + '" không tìm thấy trong bin. Kiểm tra lại tên.';
      statusEl.style.display = 'block'; return;
    }

    // Unique parent folders
    var folders = [];
    matches.forEach(function(b) {
      if (b.parent && folders.indexOf(b.parent) === -1) folders.push(b.parent);
    });

    if (folders.length === 1) {
      // Only one folder → apply directly, no need to ask
      inputEl.value = folders[0] + ' ' + srcName;
      statusEl.textContent = '✓ Đã thêm hint "' + folders[0] + '". Validate lại để xác nhận.';
      statusEl.style.display = 'block';
      sacValidatePassed = false; sacUpdateRunVisibility();
      return;
    }

    // Multiple folders → show choice panel
    statusEl.innerHTML = '';
    statusEl.style.display = 'block';
    var msg = document.createElement('div');
    msg.textContent = '"' + srcName + '" có trong ' + folders.length + ' folder — chọn đúng:';
    msg.style.cssText = 'font-size:10px;margin-bottom:6px;color:rgba(255,255,255,0.6);';
    statusEl.appendChild(msg);

    var btnWrap = document.createElement('div');
    btnWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;';
    folders.forEach(function(folder) {
      var btn = document.createElement('button');
      btn.className = 'sac-folderHintBtn';
      btn.textContent = folder;
      btn.addEventListener('click', function() {
        inputEl.value = folder + ' ' + srcName;
        statusEl.innerHTML = '';
        statusEl.textContent = '✓ Đã thêm hint "' + folder + '". Validate lại để xác nhận.';
        sacValidatePassed = false; sacUpdateRunVisibility();
      });
      btnWrap.appendChild(btn);
    });
    statusEl.appendChild(btnWrap);
  }

  // ── Populate from AI-parsed data (used by Phase 2 screenshot parser) ────
  window.sacLoadBlocks = function(blocks) {
    renderBlocks(blocks);
  };

  window.sacLoadRows = function(rows) {
    $('sacBody').innerHTML = '';
    rowSeq = 0;
    rows.forEach(function(r) { createRow(r.text, r.time, r.src); });
  };

  // ── Cross-tab entry point: Claude Chat → Autocut ─────────────────────────
  // Called from ppExecuteAction (action: 'autocut_load'). Switches to the
  // Autocut tab + Manual panel, then fills the spreadsheet with {text,time,src}
  // rows (passed through expandRows so multi-line / multi-timestamp cells split
  // the same way pasting or the screenshot parser does).
  window.AutocutPushRows = function(rows) {
    // 1. Switch to the Autocut tab
    var tabBtn = document.querySelector('.tab-btn[data-tab="autocut"]');
    if (tabBtn) tabBtn.click();
    // 2. Force the Manual panel active
    document.querySelectorAll('.sac-methodBtn').forEach(function(b) {
      b.classList.toggle('is-active', b.dataset.method === 'manual');
    });
    $('sacPanelManual').style.display = 'flex';
    $('sacPanelScreenshot').style.display = 'none';
    // 3. Reset block preview/status from any previous run
    $('sacBlockSection').style.display = 'none';
    $('sacStatus').style.display = 'none';
    parsedBlocks = [];
    // 4. Fill the spreadsheet
    $('sacBody').innerHTML = ''; rowSeq = 0;
    var expanded = expandRows((rows || []).map(function(r) {
      return [ r.text || '', r.time || '', r.src || '' ];
    }));
    if (expanded.length === 0) { createRow(); createRow(); createRow(); return; }
    expanded.forEach(function(cols) { createRow(cols[0], cols[1], cols[2]); });
  };

  // ── Voice pipeline (Phase 4a) ────────────────────────────────────────────
  // Pick a single voice file covering the whole cutsheet, transcribe + align it
  // per block, and attach voiceStart/voiceEnd/voiceDuration to each block.
  function sacPickVoiceFile() {
    if (sacVoiceBusy) { sacSetVoiceInfo('⏳ Đang xử lý voice, đợi chút...'); return; }
    try {
      var uxp = require('uxp');
      uxp.storage.localFileSystem.getFileForOpening({
        types: ['mp3','wav','m4a','aac','ogg','flac'],
      }).then(function(file) {
        if (!file) return;
        var fp = file.nativePath || file.path || '';
        if (!fp) { sacSetVoiceInfo('❌ Không lấy được đường dẫn file'); return; }
        sacAlignVoice(fp);
      }).catch(function(e) { console.error('[SAC] voice picker:', e); });
    } catch(e) {
      sacSetVoiceInfo('❌ File picker không khả dụng: ' + e.message);
    }
  }

  function sacSetVoiceInfo(msg) {
    var el = $('sacVoiceInfo');
    if (el) el.textContent = msg;
  }

  // ── Mini audio player (Approach B) ────────────────────────────────────────
  // UXP can't play audio inline → playback goes through the bridge (/tts/play
  // = afplay) just like the Voice Gen tab. We only drive the DOM + a timer.
  var sacVP = { path: null, playing: false, dur: 0, startedAt: 0, ticker: null };
  function sacVPFmt(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }
  function sacVPTick() {
    var el = (Date.now() - sacVP.startedAt) / 1000;
    if (sacVP.dur > 0 && el > sacVP.dur) el = sacVP.dur;
    $('sacVoiceTime').textContent = sacVPFmt(el) + ' / ' + sacVPFmt(sacVP.dur);
    $('sacVoiceFill').style.width = sacVP.dur > 0 ? (el / sacVP.dur * 100).toFixed(1) + '%' : '0%';
  }
  function sacVPStop() {
    if (sacVP.ticker) { clearInterval(sacVP.ticker); sacVP.ticker = null; }
    sacVP.playing = false;
    var btn = $('sacVoicePlay'); if (btn) piSetBtn(btn, 'play');
    fetch(BRIDGE_URL + '/tts/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(function(){});
  }
  function sacVPPlay() {
    if (!sacVP.path) return;
    sacVP.playing = true; sacVP.startedAt = Date.now();
    var btn = $('sacVoicePlay'); if (btn) piSetBtn(btn, 'pause');
    sacVP.ticker = setInterval(sacVPTick, 200);
    fetch(BRIDGE_URL + '/tts/play', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: sacVP.path }),
    }).then(function(r) { return r.json(); }).then(function() {
      if (sacVP.ticker) { clearInterval(sacVP.ticker); sacVP.ticker = null; }
      sacVP.playing = false;
      var b = $('sacVoicePlay'); if (b) piSetBtn(b, 'play');
      $('sacVoiceFill').style.width = sacVP.dur > 0 ? '100%' : '0%';
    }).catch(function() {
      sacVP.playing = false; var b = $('sacVoicePlay'); if (b) piSetBtn(b, 'play');
    });
  }
  function sacVoicePlayerSetSrc(path) {
    if (sacVP.playing) sacVPStop();
    sacVP.path = path; sacVP.dur = 0;
    $('sacVoicePlayer').style.display = 'flex';
    $('sacVoiceFill').style.width = '0%';
    $('sacVoiceTime').textContent = '0:00 / ?';
    fetch(BRIDGE_URL + '/tts/duration', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioPath: path }),
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d && d.ok && d.duration > 0) {
        sacVP.dur = d.duration;
        $('sacVoiceTime').textContent = '0:00 / ' + sacVPFmt(d.duration);
      }
    }).catch(function(){});
  }

  // Mark the gen-voice button as "ready" (script normalized + pushed to Voice Gen).
  function sacMarkScriptPrepared(ready) {
    sacScriptPrepared = ready;
    var b = $('sacVoiceGenBtn');
    if (!b) return;
    if (ready) { piSetBtn(b, 'microphone_lines', 'Gen voice ngay →', '#10b981', 13); b.classList.add('is-ready'); }
    else       { piSetBtn(b, 'bolt', 'Gen voice (Voice Gen) →', '#d8b4fe', 13); b.classList.remove('is-ready'); }
  }

  // ── Gen voice = normalize via Claude → push to Voice Gen tab ───────────────
  // opts.switchTab === false → prepare in the background (stay on Autocut); used
  // automatically right after Validate. opts.silent → don't show "nothing to gen".
  // Cancel an in-flight normalize (e.g. user edits/clears the script after Validate).
  function sacCancelNorm() {
    sacNormToken++; // any in-flight run sees a stale token and bails out
    if (sacNormAbort) { try { sacNormAbort.abort(); } catch(e) {} sacNormAbort = null; }
  }

  async function sacGenVoice(opts) {
    opts = opts || {};
    if (sacVoiceBusy) { if (!opts.silent) sacSetVoiceInfo('⏳ Đang xử lý voice, đợi chút...'); return; }
    var blocks = parseBlocks();
    if (blocks.length === 0) { if (!opts.silent) sacSetVoiceInfo('⚠ Chưa có script để gen.'); return; }

    // One line per block (join multi-text blocks with space)
    var lines = blocks.map(function(b) { return b.texts.join(' '); });

    // Cancellable: a newer normalize / a Clear / a script edit bumps the token so
    // this run's result is ignored (and the fetch is aborted) instead of clobbering
    // the UI with a stale normalized script.
    var myToken = ++sacNormToken;
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    sacNormAbort = ctrl;

    var cfg = window.sacOrganizeConfig ? window.sacOrganizeConfig() : { provider: 'anthropic', model: null, apiKey: '' };
    sacSetVoiceInfo('⏳ Chuẩn hóa script (' + cfg.model + ')...');
    var normalizedLines = lines; // fallback = originals
    try {
      var resp = await fetch(BRIDGE_URL + '/superautocut/normalize-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: lines, provider: cfg.provider, model: cfg.model, apiKey: cfg.apiKey }),
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (myToken !== sacNormToken) return; // cancelled/superseded while fetching
      var d = await resp.json();
      if (myToken !== sacNormToken) return;
      // Normalize giờ tách câu (mỗi câu 1 dòng + [emotion]) → số dòng KHÔNG bằng
      // số block; chỉ là input cho ElevenLabs. Voice-align map block↔audio bằng
      // block.texts riêng nên không cần khớp số dòng. Nhận mọi kết quả non-empty.
      if (d.ok && Array.isArray(d.lines) && d.lines.length) {
        normalizedLines = d.lines;
        console.log('[SAC] Script normalized:', normalizedLines);
      } else {
        console.warn('[SAC] Normalize skipped:', d.error || d.warning);
      }
    } catch(e) {
      if (myToken !== sacNormToken) return; // aborted — stay quiet
      console.warn('[SAC] Normalize bridge error:', e.message, '— dùng script gốc');
    }
    if (myToken !== sacNormToken) return; // final guard before touching the UI
    sacNormAbort = null;

    var text = normalizedLines.join('\n');
    if (typeof window.VoiceGenPushScript === 'function') {
      // switchTab=false → keep the user on Autocut while preparing in the background
      window.VoiceGenPushScript(text, null, false, opts.switchTab !== false);
      sacMarkScriptPrepared(true);
      sacSetVoiceInfo(opts.switchTab !== false
        ? '→ Script đã đẩy sang Voice Gen. Chọn giọng + Generate, rồi bấm "→ Autocut".'
        : '✅ Script đã chuẩn hoá — voice sẵn sàng để gen. Bấm "🎙 Gen voice ngay".');
    } else {
      if (!opts.silent) sacSetVoiceInfo('❌ Voice Gen chưa sẵn sàng.');
    }
  }

  // Show the "gen voice?" confirm popup → resolves true (gen) / false (validate only)
  // / 'cancel' (abort validate). Hides .sac-app while open so UXP native inputs don't
  // punch through the popup. Honors the "don't ask again" skip preference.
  function sacAskGenVoice() {
    return new Promise(function(resolve) {
      // Persistent setting decides the behaviour (Settings → Autocut gen voice).
      var mode = sacGetGenVoiceMode();
      if (mode === 'auto')  { resolve(true);  return; } // always gen, no popup
      if (mode === 'never') { resolve(false); return; } // validate only, no popup
      var modal  = $('sacGenConfirm');
      var yes    = $('sacGenConfirmYes');
      var no     = $('sacGenConfirmNo');
      var cancel = $('sacGenConfirmCancel');
      if (!modal || !yes || !no) { resolve(true); return; } // fail-open
      var app = document.querySelector('#tab-autocut .sac-app');
      function done(val) {
        modal.hidden = true;
        if (app) app.style.display = '';
        if (window.releaseKeyboard) window.releaseKeyboard();
        yes.onclick = null; no.onclick = null; if (cancel) cancel.onclick = null;
        resolve(val);
      }
      yes.onclick = function() { done(true); };
      no.onclick  = function() { done(false); };
      if (cancel) cancel.onclick = function() { done('cancel'); };
      if (app) app.style.display = 'none'; // hide native textboxes behind the popup
      modal.hidden = false;
      if (window.claimKeyboard) window.claimKeyboard();
    });
  }

  // Gen-voice button: if the script was already prepared (auto on validate), just
  // bring the user to the Voice Gen tab; otherwise normalize + push + switch.
  function sacGoToVoiceGen() {
    if (sacScriptPrepared) {
      var vgBtn = document.querySelector('.tab-btn[data-tab="voicegen"]');
      if (vgBtn) vgBtn.click();
      var genBtn = document.getElementById('vgGenerate');
      if (genBtn) setTimeout(function() { try { genBtn.focus(); } catch(e) {} }, 120);
      return;
    }
    sacGenVoice({ switchTab: true });
  }

  // Transcribe + align the voice file against the current blocks, then update
  // each block's voice badge and store timing on parsedBlocks. Shared by the
  // voice picker and the VoiceGen "Move to Autocut" cross-tab entry.
  async function sacAlignVoice(audioPath) {
    if (sacVoiceBusy) { sacSetVoiceInfo('⏳ Đang xử lý voice, đợi chút...'); return; }
    sacVoiceBusy = true;
    // Always align against the CURRENT spreadsheet, not the last-validated blocks.
    var fresh = parseBlocks();
    if (fresh.length === 0) {
      sacSetVoiceInfo('⚠ Chưa có script. Điền/paste script rồi chọn voice lại.');
      sacVoiceBusy = false;
      sacVoicePath = audioPath;
      return;
    }
    // Re-render block cards if they're stale vs the spreadsheet, so the voice
    // badges map onto blocks that actually match the current script.
    var freshKey = JSON.stringify(fresh.map(function(b) { return b.texts; }));
    var shownKey = JSON.stringify(parsedBlocks.map(function(b) { return b.texts; }));
    if (freshKey !== shownKey) renderBlocks(fresh);

    sacVoicePath = audioPath;
    sacVoicePlayerSetSrc(audioPath); // show mini player for any voice source
    var shortName = audioPath.split('/').pop();
    sacSetVoiceInfo('⏳ Align: ' + shortName + '...');

    try {
      var resp = await fetch(BRIDGE_URL + '/superautocut/voice-align', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioPath: audioPath,
          blocks: parsedBlocks.map(function(b) { return { texts: b.texts }; }),
        }),
      });
      var d = await resp.json();
      if (!d.ok) { sacSetVoiceInfo('❌ ' + (d.error || 'align lỗi')); return; }

      // Log what Whisper heard so content mismatches are easy to spot.
      console.log('[SAC] Voice transcript:', d.fullText || '(rỗng)');

      var matched = 0;
      (d.alignments || []).forEach(function(a, i) {
        if (!parsedBlocks[i]) return;
        parsedBlocks[i].voiceDuration = a.duration;
        // Only count blocks that Whisper TRULY matched (not gap-filled interpolations)
        var trulyMatched = (a.status === 'matched' && a.duration != null);
        if (trulyMatched) {
          parsedBlocks[i].voiceStart = a.start;
          parsedBlocks[i].voiceEnd   = a.end;
          matched++;
        } else {
          // Chưa khớp → bỏ voice cho block này (assembly chỉ đặt video, không voice).
          parsedBlocks[i].voiceStart = null;
          parsedBlocks[i].voiceEnd   = null;
        }
        var badge = document.querySelector('.sac-blockVoiceBadge[data-block-idx="' + i + '"]');
        if (badge) {
          if (trulyMatched) {
            sacLabelIcon(badge, 'microphone', null, 11, a.duration.toFixed(1) + 's');
            badge.className = 'sac-blockVoiceBadge sac-voiceOk';
          } else if (a.duration != null) {
            // Gap-filled — has timing but not confirmed match
            sacLabelIcon(badge, 'microphone', null, 11, '~' + a.duration.toFixed(1) + 's');
            badge.className = 'sac-blockVoiceBadge sac-voiceWeak';
          } else {
            sacLabelIcon(badge, 'microphone', null, 11, '?');
            badge.className = 'sac-blockVoiceBadge sac-voiceMissing';
          }
        }
      });
      window.sacVoicePath = sacVoicePath; // expose for Phase 5
      // sacVoiceReady = true only when majority of blocks are truly matched
      var minMatch = Math.max(1, Math.ceil(parsedBlocks.length * 0.5));
      sacVoiceReady = (matched >= minMatch);
      sacVoiceBusy = false;
      // Which blocks have NO voice (chưa khớp) — show them so the user knows.
      var unmatchedNums = [];
      parsedBlocks.forEach(function(b, idx) { if (b.voiceStart == null) unmatchedNums.push(idx + 1); });
      sacUpdateRunVisibility();
      if (matched === 0) {
        sacSetVoiceInfo('⚠ Khớp 0/' + parsedBlocks.length + ' — voice không trùng script');
      } else if (!sacVoiceReady) {
        sacSetVoiceInfo('⚠ Khớp ' + matched + '/' + parsedBlocks.length + ' blocks. Block chưa khớp: ' + unmatchedNums.join(', ') + ' (sẽ chỉ có video).');
      } else {
        var miss = unmatchedNums.length ? (' — block ' + unmatchedNums.join(', ') + ' chỉ có video') : '';
        var hint = sacValidatePassed ? ' — Run đã mở' : ' — Validate để mở Run';
        sacSetVoiceInfo('✅ Khớp ' + matched + '/' + parsedBlocks.length + ' blocks' + miss + hint);
      }
      // "Run anyway" — validate passed but voice gate not met → let the user run
      // (matched blocks get voice; unmatched get video only).
      var raBtn = $('sacRunAnywayBtn');
      if (raBtn) raBtn.style.display = (sacValidatePassed && !sacVoiceReady && matched >= 0) ? 'flex' : 'none';
    } catch(e) {
      sacVoiceBusy = false;
      sacSetVoiceInfo('❌ Bridge offline: ' + e.message);
    }
  }

  // Cross-tab entry: VoiceGen "Move to Autocut" → reuse a generated audio file.
  window.AutocutPushVoice = function(audioPath) {
    var tabBtn = document.querySelector('.tab-btn[data-tab="autocut"]');
    if (tabBtn) tabBtn.click();
    document.querySelectorAll('.sac-methodBtn').forEach(function(b) {
      b.classList.toggle('is-active', b.dataset.method === 'manual');
    });
    $('sacPanelManual').style.display = 'flex';
    $('sacPanelScreenshot').style.display = 'none';
    sacAlignVoice(audioPath);
  };

  // ── Screenshot: UXP file picker ─────────────────────────────────────────
  var sacImgDataUrl = null;

  function sacLoadImageFile(file) {
    file.read({ format: require('uxp').storage.formats.binary })
      .then(function(data) {
        var bytes = new Uint8Array(data);
        var bin = '';
        for (var b = 0; b < bytes.length; b++) bin += String.fromCharCode(bytes[b]);
        var ext  = file.name.split('.').pop().toLowerCase();
        var mime = (ext === 'png') ? 'image/png' : 'image/jpeg';
        sacImgDataUrl = 'data:' + mime + ';base64,' + btoa(bin);

        // Plain <img> preview — reliable in UXP (canvas + new Image() is flaky)
        var preview = $('sacImgPreview');
        preview.src = sacImgDataUrl;
        preview.hidden = false;
        preview.style.display = 'block';
        // swap the card into "has image" mode: hide the prompt, show preview
        $('sacDrop').classList.add('has-image');
        $('sacDropPrompt').style.display = 'none';
        $('sacParseImg').disabled = false;
        $('sacImgStatus').textContent = '';
        $('sacImgStatus').style.display = 'none';
      })
      .catch(function(e) {
        $('sacImgStatus').textContent = '❌ Không đọc được file: ' + e.message;
        $('sacImgStatus').style.display = 'block';
      });
  }

  function sacOpenImagePicker() {
    try {
      var storage = require('uxp').storage;
      storage.localFileSystem.getFileForOpening({
        allowMultiple: false,
        types: storage.fileTypes.images,
      }).then(function(file) {
        if (!file) return;
        sacLoadImageFile(file);
      }).catch(function(e) {
        console.error('[SAC] file picker:', e);
      });
    } catch(e) {
      $('sacImgStatus').textContent = '❌ File picker không khả dụng: ' + e.message;
      $('sacImgStatus').style.display = 'block';
    }
  }

  // Clicking anywhere on the big card opens the picker (also re-picks to swap image)
  var sacDrop = $('sacDrop');
  if (sacDrop) sacDrop.addEventListener('click', sacOpenImagePicker);

  // ── Event listeners ──────────────────────────────────────────────────────
  // Column-order preset: restore saved order, bind the preset picker, apply.
  sacLoadColOrder();
  var sacColPreset = document.getElementById('sacColPreset');
  if (sacColPreset) {
    // Lives inside the collapsible header bar → stop clicks toggling the section.
    sacColPreset.addEventListener('click', function(e) { e.stopPropagation(); });
    sacColPreset.addEventListener('change', function(e) {
      e.stopPropagation();
      var keys = (sacColPreset.value || '').split(',');
      if (keys.length === 3 && keys.indexOf('text') >= 0 && keys.indexOf('time') >= 0 && keys.indexOf('src') >= 0) {
        SAC_COL_ORDER = keys;
        sacSaveColOrder();
        sacApplyColOrder();
      }
    });
  }
  sacApplyColOrder();

  $('sacAddRow').addEventListener('click', function() { createRow(); });

  $('sacClearBoard').addEventListener('click', function() {
    $('sacBody').innerHTML = '';
    rowSeq = 0;
    $('sacBlockSection').style.display = 'none';
    $('sacStatus').style.display = 'none';
    parsedBlocks = [];
    createRow(); createRow(); createRow();
  });

  // Validate = render blocks + check sources in bin + check structure (1 click).
  $('sacPreviewBtn').addEventListener('click', function() { sacValidateAll(); });

  async function sacValidateAll(opts) {
    opts = opts || {};
    var btn = $('sacPreviewBtn');
    var status = $('sacStatus');
    // Pull this project's remembered binds BEFORE parsing, so saved overrides apply
    // to the freshly parsed sources (no need to re-bind across tasks).
    sacLoadProjectBinds(await sacCurrentProjectKey());
    var blocks = parseBlocks();
    if (blocks.length === 0) {
      status.textContent = 'Chưa có dữ liệu. Điền ít nhất 1 dòng có cả Script và Source.';
      status.style.display = 'block';
      return;
    }

    // Ask FIRST — before touching any UI — so Cancel leaves everything as-is.
    // Skipped for 🔄 re-validate and "Without voice" mode.
    var wantVoice = false;
    if (!opts.skipVoiceAsk && !sacNoVoiceMode) {
      var ans = await sacAskGenVoice();
      if (ans === 'cancel') return;     // abort validate, nothing changed
      wantVoice = (ans === true);
    }

    renderBlocks(blocks); // shows block cards with ⌛ on each source
    sacMarkScriptPrepared(false); // fresh validate → script may have changed
    sacCancelNorm();              // drop any earlier in-flight normalize
    if (wantVoice) sacGenVoice({ switchTab: false, silent: true });

    // Collapse script section immediately on validate
    var wrap = $('sacTableWrap'), footer = $('sacTableFooter');
    if (wrap && wrap.style.display !== 'none') {
      wrap.style.display = 'none';
      if (footer) footer.style.display = 'none';
      var chev = $('sacScriptChevron');
      if (chev) chev.textContent = '▸';
      var blockSec = $('sacBlockSection');
      if (blockSec) blockSec.style.flex = '1 1 0';
    }

    btn.disabled = true;
    piSetBtn(btn, 'rotate_right', 'Validating...', null, 12);
    status.textContent = '⏳ Đang kiểm tra source + cấu trúc...';
    status.style.display = 'block';
    var myVTok = ++sacValidateToken; // a Clear (or newer validate) invalidates this run

    try {
      // 1) Source validation against the Premiere bin (updates ✓/✗ icons)
      var srcResult = await sacValidateSources(blocks);
      if (myVTok !== sacValidateToken) return; // cancelled mid-flight (e.g. Clear)

      // 2) Structure validation via bridge
      var resp = await fetch(BRIDGE_URL + '/superautocut/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks: blocks }),
      });
      var d = await resp.json();
      if (myVTok !== sacValidateToken) return; // cancelled mid-flight

      if (!d.ok) {
        status.textContent = '❌ ' + (d.errors ? d.errors.join(' | ') : d.error);
        sacValidatePassed = false;
      } else if (srcResult.missing.length > 0) {
        status.textContent = '⚠ Cấu trúc OK nhưng thiếu source trong bin: '
          + srcResult.missing.join(', ') + ' (xem Console).';
        sacValidatePassed = false;
      } else if (srcResult.ambiguous && srcResult.ambiguous.length > 0) {
        // Ambiguous sources: structure OK + all found, but some names match multiple clips
        status.innerHTML = '⚠ Source trùng tên — cần folder hint (bấm ' + sacFolderIco() + '): '
          + sacEsc(srcResult.ambiguous.join(', '));
        sacValidatePassed = false;
      } else {
        var note = srcResult.premiereAvailable ? '' : ' (dev mode — chưa kiểm tra bin)';
        sacValidatePassed = true;
        status.textContent = sacVoiceReady
          ? ('✅ ' + d.blockCount + ' blocks OK + voice sẵn sàng. Bấm "Run AutoCut".' + note)
          : ('✅ ' + d.blockCount + ' blocks hợp lệ. Thêm voice (⚡ Gen / 📂) để mở Run.' + note);
        // Auto-collapse script section after successful validate
        var wrap = $('sacTableWrap'), footer = $('sacTableFooter');
        if (wrap && wrap.style.display !== 'none') {
          wrap.style.display = 'none';
          if (footer) footer.style.display = 'none';
          var chev = $('sacScriptChevron');
          if (chev) chev.textContent = '▸';
          var blockSec = $('sacBlockSection');
          if (blockSec) blockSec.style.flex = '1 1 0';
        }
      }
      sacUpdateRunVisibility();
    } catch(e) {
      status.textContent = '❌ Bridge offline: ' + e.message;
      sacValidatePassed = false;
      sacUpdateRunVisibility();
    } finally {
      btn.disabled = false;
      piSetBtn(btn, 'check', 'Validate', null, 12);
    }
  }

  // ── Parse với AI (screenshot → rows) ────────────────────────────────────
  var sacParseImg = $('sacParseImg');
  if (sacParseImg) {
    sacParseImg.addEventListener('click', function() {
      if (!sacImgDataUrl) return;
      sacParseImg.disabled = true;
      piSetBtn(sacParseImg, 'rotate_right', 'Đang phân tích...', null, 12);
      $('sacImgStatus').textContent = '';
      $('sacImgStatus').style.display = 'none';

      fetch(BRIDGE_URL + '/superautocut/parse-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: sacImgDataUrl }),
      })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          sacParseImg.disabled = false;
          piSetBtn(sacParseImg, 'wand_magic_sparkles', 'Parse với AI →', null, 12);
          if (!d.ok || !d.rows || d.rows.length === 0) {
            $('sacImgStatus').textContent = '❌ ' + (d.error || 'Không parse được.');
            $('sacImgStatus').style.display = 'block';
            return;
          }
          // Switch to manual tab and load rows
          document.querySelectorAll('.sac-methodBtn').forEach(function(b) {
            b.classList.toggle('is-active', b.dataset.method === 'manual');
          });
          $('sacPanelManual').style.display = 'flex';
          $('sacPanelScreenshot').style.display = 'none';
          $('sacBody').innerHTML = ''; rowSeq = 0;
          var expanded = expandRows(d.rows.map(function(r) {
            return [ r.text || '', r.time || '', r.source || '' ];
          }));
          expanded.forEach(function(cols) {
            createRow(cols[0], cols[1], cols[2]);
          });
        })
        .catch(function(e) {
          sacParseImg.disabled = false;
          piSetBtn(sacParseImg, 'wand_magic_sparkles', 'Parse với AI →', null, 12);
          $('sacImgStatus').textContent = '❌ Bridge lỗi: ' + e.message;
          $('sacImgStatus').style.display = 'block';
        });
    });
  }

  var sacClearBlocksBtn = $('sacClearBlocks'); // removed from UI (replaced by Refresh Block) — guard
  if (sacClearBlocksBtn) sacClearBlocksBtn.addEventListener('click', function() {
    $('sacBlockSection').style.display = 'none';
    parsedBlocks = [];
  });

  // 🔄 Re-validate — lets the user re-run validation after importing a missing
  // source, without reopening the (now-collapsed) script + Validate button.
  var sacRefreshBtn = $('sacRefreshBlocks');
  if (sacRefreshBtn) sacRefreshBtn.addEventListener('click', function() {
    if (parseBlocks().length === 0) return;
    sacValidateAll({ skipVoiceAsk: true }); // re-check sources only — don't re-ask voice
  });

  // ── Cut panel buttons ───────────────────────────────────────────────────

  // "Without voice" button (in voice panel) → enter no-voice cut mode
  var sacCutNoVoiceBtn = $('sacCutNoVoiceBtn');
  if (sacCutNoVoiceBtn) sacCutNoVoiceBtn.addEventListener('click', function() {
    if (!sacValidatePassed) return;
    sacNoVoiceMode = true;
    sacUpdateRunVisibility();
  });

  // "Chỉ video (bỏ voice)" checkbox in the cut panel — toggle no-voice mode
  // while keeping the aligned voice intact (voice ready, panel stays open).
  var sacCutNoVoiceChk = $('sacCutNoVoiceChk');
  if (sacCutNoVoiceChk) sacCutNoVoiceChk.addEventListener('change', function() {
    sacNoVoiceMode = sacCutNoVoiceChk.checked;
    sacShowCutPanel(); // refresh label; sacVoiceReady stays true so panel persists
  });


  // "Run anyway" — bypass the voice-match gate. Matched blocks keep their voice;
  // unmatched blocks (voiceStart=null) place video only. Sources must be validated.
  var sacRunAnywayBtn = $('sacRunAnywayBtn');
  if (sacRunAnywayBtn) sacRunAnywayBtn.addEventListener('click', function() {
    if (!sacValidatePassed) { sacSetVoiceInfo('⚠ Validate source trước đã.'); return; }
    sacRunAnywayBtn.style.display = 'none';
    sacShowCutPanel(); // reveal This seq / New seq buttons
  });

  // [✕] back — return to voice panel
  // Clear all aligned voice state (✕ button — also used for "change voice")
  function sacClearVoice() {
    sacVoicePath = null;
    window.sacVoicePath = null;
    sacVoiceReady = false;
    sacNoVoiceMode = false;
    var _ra = $('sacRunAnywayBtn'); if (_ra) _ra.style.display = 'none';
    // Clear per-block timing
    parsedBlocks.forEach(function(b) {
      b.voiceStart = null; b.voiceEnd = null; b.voiceDuration = null;
    });
    // Reset voice badges on block cards
    document.querySelectorAll('.sac-blockVoiceBadge').forEach(function(el) {
      el.textContent = ''; el.className = 'sac-blockVoiceBadge';
    });
    $('sacVoicePlayer').style.display = 'none';
    sacSetVoiceInfo('Chưa có voice');
  }

  var sacCutBackBtn = $('sacCutBack');
  if (sacCutBackBtn) sacCutBackBtn.addEventListener('click', function() {
    sacClearVoice();
    sacHideCutPanel();
    sacUpdateRunVisibility();
  });

  // [▶ This seq] — run assembly into current active sequence
  var sacCutThisBtn = $('sacCutThis');
  if (sacCutThisBtn) sacCutThisBtn.addEventListener('click', function() {
    sacRunAutoCut('current');
  });

  // ── New-sequence settings popup + name presets ──────────────────────────
  var SEQ_PRESET_KEY = 'sac_seq_name_presets';
  function sacLoadSeqPresets() {
    try { return JSON.parse(localStorage.getItem(SEQ_PRESET_KEY) || '[]') || []; } catch(e) { return []; }
  }
  function sacRenderSeqPresets() {
    var sel = $('sacSeqNamePreset');
    if (!sel) return;
    var presets = sacLoadSeqPresets();
    sel.innerHTML = '<option value="">— Preset tên đã lưu —</option>';
    presets.forEach(function(p) {
      var o = document.createElement('option'); o.value = p; o.textContent = p; sel.appendChild(o);
    });
  }
  function sacOpenNewSeqModal() {
    var modal = $('sacNewSeqModal');
    if (!modal) { sacRunAutoCut('new'); return; }
    var nameInp = $('sacNewSeqName');
    if (nameInp && !nameInp.value.trim()) nameInp.value = 'AutoCut';
    sacRenderSeqPresets();
    var app = document.querySelector('#tab-autocut .sac-app');
    if (app) app.style.display = 'none'; // hide native inputs behind the modal
    modal.hidden = false;
    if (window.claimKeyboard) window.claimKeyboard();
    if (nameInp) setTimeout(function() { try { nameInp.focus(); } catch(e) {} }, 80);
  }
  function sacCloseNewSeqModal() {
    var modal = $('sacNewSeqModal');
    if (modal) modal.hidden = true;
    var app = document.querySelector('#tab-autocut .sac-app');
    if (app) app.style.display = '';
    if (window.releaseKeyboard) window.releaseKeyboard();
  }

  var sacCutNewBtn = $('sacCutNew');
  if (sacCutNewBtn) sacCutNewBtn.addEventListener('click', sacOpenNewSeqModal);

  var sacNewSeqCancel = $('sacNewSeqCancel');
  if (sacNewSeqCancel) sacNewSeqCancel.addEventListener('click', sacCloseNewSeqModal);
  var sacNewSeqCancelX = $('sacNewSeqCancelX');
  if (sacNewSeqCancelX) sacNewSeqCancelX.addEventListener('click', sacCloseNewSeqModal);

  var sacNewSeqRun = $('sacNewSeqRun');
  if (sacNewSeqRun) sacNewSeqRun.addEventListener('click', function() {
    sacCloseNewSeqModal();
    sacRunAutoCut('new'); // reads #sacNewSeqName / #sacNewSeqRatio from the modal
  });

  // Name presets: select fills the name; 💾 saves current name; 🗑 deletes selected.
  var sacSeqNamePreset = $('sacSeqNamePreset');
  if (sacSeqNamePreset) sacSeqNamePreset.addEventListener('change', function() {
    var v = sacSeqNamePreset.value;
    var nameInp = $('sacNewSeqName');
    if (v && nameInp) nameInp.value = v;
  });
  var sacSeqNameSave = $('sacSeqNameSave');
  if (sacSeqNameSave) sacSeqNameSave.addEventListener('click', function() {
    var nameInp = $('sacNewSeqName');
    var v = nameInp ? nameInp.value.trim() : '';
    if (!v) return;
    var presets = sacLoadSeqPresets();
    if (presets.indexOf(v) === -1) { presets.unshift(v); presets = presets.slice(0, 20); }
    localStorage.setItem(SEQ_PRESET_KEY, JSON.stringify(presets));
    sacRenderSeqPresets();
    if (sacSeqNamePreset) sacSeqNamePreset.value = v;
  });
  var sacSeqNameDel = $('sacSeqNameDel');
  if (sacSeqNameDel) sacSeqNameDel.addEventListener('click', function() {
    var v = sacSeqNamePreset ? sacSeqNamePreset.value : '';
    if (!v) return;
    var presets = sacLoadSeqPresets().filter(function(p) { return p !== v; });
    localStorage.setItem(SEQ_PRESET_KEY, JSON.stringify(presets));
    sacRenderSeqPresets();
  });

  // Keyboard claim/release for new seq name input
  var sacNewSeqNameInp = $('sacNewSeqName');
  if (sacNewSeqNameInp) {
    sacNewSeqNameInp.addEventListener('focus', function() { if (window.claimKeyboard) window.claimKeyboard(); });
    sacNewSeqNameInp.addEventListener('blur',  function() { if (window.releaseKeyboard) window.releaseKeyboard(); });
  }

  // ── Success panel buttons ────────────────────────────────────────────────
  var sacBackToScriptBtn = $('sacBackToScript');
  if (sacBackToScriptBtn) sacBackToScriptBtn.addEventListener('click', function() {
    $('sacSuccessPanel').style.display = 'none';
    $('sacPanelManual').style.display = 'flex';
    // Return to the BLOCK view, not the script editor: keep the script table
    // collapsed (as it was at validate time) and let the block list fill the panel.
    $('sacTableWrap').style.display = 'none';
    $('sacTableFooter').style.display = 'none';
    $('sacScriptChevron').textContent = '▸';
    $('sacBlockSection').style.display = 'flex';
    $('sacBlockSection').style.flex = '1 1 0';
  });

  var sacNewAutocutBtn = $('sacNewAutocut');
  if (sacNewAutocutBtn) sacNewAutocutBtn.addEventListener('click', function() {
    $('sacSuccessPanel').style.display = 'none';
    parsedBlocks = [];
    sacSourceMap = {};
    sacVoicePath = null;
    window.sacVoicePath = null;
    sacValidatePassed = false;
    sacVoiceReady = false;
    sacNoVoiceMode = false;
    $('sacBlockSection').style.display = 'none';
    $('sacVoicePlayer').style.display = 'none';
    $('sacVoiceInfo').textContent = 'Chưa có voice';
    $('sacStatus').style.display = 'none';
    sacBindOverrides = {}; // forget manual binds on full reset
    sacMarkScriptPrepared(false);
    sacCancelNorm();
    $('sacBody').innerHTML = '';
    rowSeq = 0;
    createRow(); createRow(); createRow();
    $('sacPanelManual').style.display = 'flex';
    // Re-open the script editor so it's ready to fill in immediately.
    $('sacTableWrap').style.display = '';
    $('sacTableFooter').style.display = '';
    $('sacScriptChevron').textContent = '▾';
    $('sacBlockSection').style.flex = '';
    sacUpdateRunVisibility();
  });

  // Voice controls (Phase 4a / Approach B)
  var sacVoiceBtn = $('sacVoiceBtn');
  if (sacVoiceBtn) sacVoiceBtn.addEventListener('click', sacPickVoiceFile);
  var sacVoiceGenBtn = $('sacVoiceGenBtn');
  if (sacVoiceGenBtn) sacVoiceGenBtn.addEventListener('click', sacGoToVoiceGen);
  var sacVoicePlay = $('sacVoicePlay');
  if (sacVoicePlay) sacVoicePlay.addEventListener('click', function() {
    if (sacVP.playing) sacVPStop(); else sacVPPlay();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 5 — Assembly  (UXP API: SequenceEditor + transaction)
  // Ref: https://developer.adobe.com/premiere-pro/uxp/ppro_reference/classes/sequenceeditor/
  // ═══════════════════════════════════════════════════════════════════════════

  // Parse "M:SS" or "M:SS-M:SS" → {inSec, outSec}. Single ts defaults to 3s.
  function parseSourceTime(str) {
    // Empty/missing → null = use full clip duration, no in/out restriction.
    if (str == null) return { inSec: null, outSec: null };
    var s = String(str).trim();
    if (!s) return { inSec: null, outSec: null };
    // Minute marker: "3p49" / "3 phút 49" / "3'49" mean 3 min 49 sec. Normalize the
    // minute→second separator to ":" BEFORE tokenizing, otherwise the "p" splits it
    // into two bare-second tokens ("3","49") and "3p49-3p52" wrongly reads as 3s→49s.
    // Only fires when a digit sits on BOTH sides, so it never touches source names.
    s = s.replace(/(\d+)\s*(?:ph[uú]t|p|['′])\s*(\d+)/gi, '$1:$2');
    // Separator-agnostic: pull out the time-like tokens (H:MM:SS / M:SS / bare
    // seconds, optional decimals) no matter what joins them — hyphen, en/em/figure
    // dash, minus sign, "to", spaces, etc. This is why a cutsheet whose dash got
    // auto-converted to "–" was failing to parse and every clip fell back to a gap.
    var tokens = s.match(/\d+(?::\d+){0,2}(?:\.\d+)?/g);
    if (!tokens || !tokens.length) return { inSec: null, outSec: null };
    function toSec(t) {
      var seg = t.split(':').map(function(x) { return parseFloat(x); });
      if (seg.some(function(n) { return isNaN(n); })) return null;
      if (seg.length === 1) return seg[0];
      if (seg.length === 2) return seg[0] * 60 + seg[1];
      return seg[0] * 3600 + seg[1] * 60 + seg[2];
    }
    var inSec = toSec(tokens[0]);
    if (inSec === null) return { inSec: null, outSec: null };
    var outSec = tokens.length > 1 ? toSec(tokens[1]) : null;
    if (outSec === null) outSec = inSec + 3; // single time → default 3s window
    return { inSec: inSec, outSec: Math.max(outSec, inSec + 0.1) };
  }

  // Format a raw cutsheet time string into a clean timecode for DISPLAY only.
  // "giây số 5" → "0:05", "giây 18-19" → "0:18-0:19", "0:02-0:08" → "0:02-0:08".
  // Single point shows just that point (no +3s default); unparseable → raw text back.
  function sacFmtTimeBadge(raw) {
    if (raw == null) return '';
    var s = String(raw).normalize('NFC').trim();
    if (!s) return '';
    var tokens = s.match(/\d+(?::\d+){0,2}(?:\.\d+)?/g);
    if (!tokens || !tokens.length) return s; // no time inside → keep original text
    function toSec(t) {
      var seg = t.split(':').map(function(x) { return parseFloat(x); });
      if (seg.some(function(n) { return isNaN(n); })) return null;
      if (seg.length === 1) return seg[0];
      if (seg.length === 2) return seg[0] * 60 + seg[1];
      return seg[0] * 3600 + seg[1] * 60 + seg[2];
    }
    function fmt(sec) {
      if (sec == null) return '';
      var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), ss = sec % 60;
      var whole = Math.floor(ss);
      var frac  = Math.round((ss - whole) * 1000) / 1000;
      var secPart = (whole < 10 ? '0' : '') + whole + (frac ? ('.' + String(frac).slice(2)) : '');
      return h > 0 ? (h + ':' + (m < 10 ? '0' : '') + m + ':' + secPart) : (m + ':' + secPart);
    }
    var inSec = toSec(tokens[0]);
    if (inSec == null) return s;
    if (tokens.length > 1) {
      var outSec = toSec(tokens[1]);
      if (outSec != null) return fmt(inSec) + '-' + fmt(outSec);
    }
    return fmt(inSec);
  }

  // TickTime via ppro.TickTime.createWithSeconds (official UXP API).
  function sacMakeTime(seconds) {
    // Guard NaN/Infinity/âm — TickTime.createWithSeconds(NaN) có thể làm Premiere crash (sync, không catch được).
    if (!isFinite(seconds) || seconds < 0) {
      console.warn('[SAC] sacMakeTime: invalid seconds', seconds, '→ dùng 0');
      seconds = 0;
    }
    if (ppro && ppro.TickTime) {
      try { return ppro.TickTime.createWithSeconds(seconds); } catch(e) {}
    }
    return { seconds: seconds, ticks: secToTicks(seconds) };
  }

  // Return seconds position of the last clip on V1 (append cursor).
  // Scan one track for the furthest clip end (seconds).
  async function sacScanTrackEnd(track, endRef) {
    if (!track) return;
    try {
      var items = await getClipItems(track);
      for (var i = 0; i < items.length; i++) {
        try {
          var e = items[i].getEnd && items[i].getEnd();
          if (e && typeof e.then === 'function') e = await e;
          var eSec = getTimeSec(e);
          if (eSec > endRef.v) endRef.v = eSec;
        } catch(er) {}
      }
    } catch(er) {}
  }

  // Return the end position (seconds) of the last clip across ALL tracks.
  // Checks video+audio via multiple API paths so the cursor never resets to 0.
  async function sacGetSequenceEnd(seq) {
    var endRef = { v: 0 }; // use object so sacScanTrackEnd can mutate it

    // Path A: trackGroup API (if ppro.Backend exists)
    try {
      if (ppro.Backend && seq.trackGroup) {
        var TYPES = [ppro.Backend.MEDIATYPE_VIDEO, ppro.Backend.MEDIATYPE_AUDIO];
        for (var ti = 0; ti < TYPES.length; ti++) {
          var grp = seq.trackGroup(TYPES[ti]);
          if (!grp) continue;
          for (var gi = 0; gi < grp.numTracks; gi++) {
            await sacScanTrackEnd(grp.getTrack(gi), endRef);
          }
        }
      }
    } catch(eA) {}

    // Path B: getVideoTrack / getAudioTrack — always try regardless of Path A result
    var trackGetters = [
      { cntFn: 'getVideoTrackCount', getFn: 'getVideoTrack' },
      { cntFn: 'getAudioTrackCount', getFn: 'getAudioTrack' },
    ];
    for (var p = 0; p < trackGetters.length; p++) {
      try {
        var cntRaw = seq[trackGetters[p].cntFn] && seq[trackGetters[p].cntFn]();
        if (cntRaw && typeof cntRaw.then === 'function') cntRaw = await cntRaw;
        var cnt = Number(cntRaw) || 0;
        for (var idx = 0; idx < cnt; idx++) {
          var tr = seq[trackGetters[p].getFn] && seq[trackGetters[p].getFn](idx);
          if (tr && typeof tr.then === 'function') tr = await tr;
          await sacScanTrackEnd(tr, endRef);
        }
      } catch(eB) {}
    }

    // Path C: sequence duration fallback
    if (endRef.v === 0) {
      try {
        var dur = seq.getDuration && seq.getDuration();
        if (dur && typeof dur.then === 'function') dur = await dur;
        var d = getTimeSec(dur);
        if (d > 0) endRef.v = d;
      } catch(eC) {}
    }

    // Guard: nếu mọi path trả giá trị lỗi (NaN/undefined) → 0, tránh cursor=NaN lan ra toàn assembly.
    if (!isFinite(endRef.v) || endRef.v < 0) {
      console.warn('[SAC] sacGetSequenceEnd: invalid end', endRef.v, '→ 0');
      endRef.v = 0;
    }
    console.log('[SAC] sacGetSequenceEnd =', endRef.v.toFixed(2) + 's');
    return endRef.v;
  }

  // Find or import a file: search bin first, only import if not already in project.
  // Prevents duplicate imports when Run AutoCut is called multiple times.
  async function sacFindOrImportFile(filePath) {
    var proj = await getActiveProject();
    var rootItem = null;
    if (typeof proj.getRootItem === 'function') {
      rootItem = proj.getRootItem();
      if (rootItem && typeof rootItem.then === 'function') rootItem = await rootItem;
    }
    if (!rootItem) rootItem = proj.rootItem;

    var fname = filePath.split('/').pop().split('\\').pop();
    var binItems = rootItem ? (await sacCollectBinItems(rootItem)) : [];

    // Search existing bin first
    var found = binItems.find(function(b) { return b.name === fname; });
    if (found) {
      console.log('[SAC] Voice already in project bin:', fname);
      return found.item;
    }

    // Not found — import
    if (typeof proj.importFiles === 'function') {
      await proj.importFiles([filePath]);
    } else if (typeof proj.importFile === 'function') {
      await proj.importFile(filePath);
    } else {
      throw new Error('No importFiles API on project');
    }
    // Re-scan bin to find the newly imported item
    var binItems2 = rootItem ? (await sacCollectBinItems(rootItem)) : [];
    var found2 = binItems2.find(function(b) { return b.name === fname; });
    // Move to "voice over" bin — only if the toggle is on (was unconditional).
    if (found2) await ppMoveToVOBinIfEnabled(found2.item, proj);
    return found2 ? found2.item : null;
  }

  // Commit a single lockedAccess/executeTransaction and await if needed.
  async function sacCommitTx(project, fn, label) {
    // Catch inside lockedAccess so a throwing transaction never escapes the lock
    // (an uncaught throw here can wedge/crash Premiere). Surface it to the caller.
    var err = null;
    var r = project.lockedAccess(function() {
      try { project.executeTransaction(fn, label || 'SAC tx'); }
      catch (e) { err = e; }
    });
    if (r && typeof r.then === 'function') await r;
    if (err) throw err;
  }

  // Place a clip on the timeline.
  // TWO separate committed transactions: (1) set source in/out, (2) insert.
  // Reason: in a combined transaction, createSetInOutPointsAction on a shared
  // master clip (e.g. the voice file) takes effect after the transaction commits,
  // not before the insert action inside the SAME transaction. Splitting into two
  // separate commits ensures in/out is fully applied before the insert runs.
  // vIdx = video track (0=V1), 5 = far-away track (effectively skip). aIdx similar.
  async function sacInsertClipAt(project, seqEditor, item, atSec, inSec, outSec, vIdx, aIdx) {
    // Guard NaN/Infinity trước mọi TickTime: atSec lỗi → 0; in/out lỗi → bỏ range (full clip).
    if (!isFinite(atSec)) { console.warn('[SAC] insert atSec invalid', atSec, '→ 0'); atSec = 0; }
    if (inSec  !== null && !isFinite(inSec))  { console.warn('[SAC] insert inSec invalid',  inSec);  inSec  = null; }
    if (outSec !== null && !isFinite(outSec)) { console.warn('[SAC] insert outSec invalid', outSec); outSec = null; }
    var timeAt = sacMakeTime(atSec);
    // inSec/outSec null → full clip (skip setInOutPoints)
    var hasRange = (inSec !== null && outSec !== null);
    var inPt  = hasRange ? sacMakeTime(inSec)  : null;
    var outPt = hasRange ? sacMakeTime(outSec) : null;

    var clipItem = null;
    if (ppro.ClipProjectItem) {
      try { clipItem = ppro.ClipProjectItem.cast(item); } catch(e) {}
    }

    // Tx 1: commit in/out only when range is specified (null = full clip)
    if (hasRange && clipItem && typeof clipItem.createSetInOutPointsAction === 'function') {
      await sacCommitTx(project, function(ca) {
        ca.addAction(clipItem.createSetInOutPointsAction(inPt, outPt));
      }, 'SAC set in/out');
    }

    // Tx 2: insert — master clip in/out is now committed, insert uses it
    await sacCommitTx(project, function(ca) {
      ca.addAction(seqEditor.createOverwriteItemAction(item, timeAt, vIdx, aIdx));
    }, 'SAC insert clip');
  }

  async function sacRunAutoCut(seqMode) {
    seqMode = seqMode || 'current';
    var status = $('sacStatus');
    status.style.display = 'block';
    status.textContent = '⏳ Đang khởi động assembly...';

    try {
      if (!ppro) throw new Error('Premiere Pro API không khả dụng — chạy trong Premiere');
      if (!ppro.SequenceEditor) throw new Error('ppro.SequenceEditor không có — Premiere 25.x+ required');

      var blocks = parsedBlocks.filter(function(b) {
        return (b.sources && b.sources.length > 0) || (!sacNoVoiceMode && b.voiceStart != null);
      });
      if (blocks.length === 0) throw new Error('Không có blocks — validate + align voice trước');

      var project = await getActiveProject();
      var seq, cursor;

      if (seqMode === 'new') {
        status.textContent = '⏳ Tạo sequence mới...';
        // Read settings from the popup.
        var nameInp  = $('sacNewSeqName');
        var ratioSel = $('sacNewSeqRatio');
        var seqName  = (nameInp && nameInp.value.trim()) || 'AutoCut';
        var ratio    = ratioSel ? ratioSel.value : 'match';

        // Create an EMPTY sequence. We deliberately do NOT use createSequenceFromMedia:
        // it drops the first source clip onto the timeline (the user found that
        // crash-prone). Trade-off: fps = project's default sequence fps (timebase is
        // immutable after creation), not the source clip's fps. Frame size is still
        // overridden below for a custom ratio.
        if (typeof project.createSequence === 'function') {
          seq = await project.createSequence(seqName);
        }
        if (!seq) throw new Error('Không tạo được sequence mới (createSequence)');
        // Let Premiere finish registering the new sequence before touching it.
        await new Promise(function(r) { setTimeout(r, 700); });

        // Rename explicitly to the full literal name — guards against any name
        // mangling (e.g. trailing ".xxx" being treated as an extension).
        try {
          var pit = (seq.getProjectItem && seq.getProjectItem()) || seq.projectItem || null;
          if (pit && typeof pit.then === 'function') pit = await pit;
          var renameTarget = (pit && typeof pit.createSetNameAction === 'function') ? pit
                           : (typeof seq.createSetNameAction === 'function' ? seq : null);
          if (renameTarget) {
            await sacCommitTx(project, function(ca) { ca.addAction(renameTarget.createSetNameAction(seqName)); }, 'SAC rename seq');
            console.log('[SAC] Sequence renamed →', seqName);
          } else {
            console.warn('[SAC] No rename API — sequence name may be truncated by Premiere');
          }
        } catch (eRn) { console.warn('[SAC] rename seq failed:', eRn && eRn.message); }

        // Apply custom frame size (ratio ≠ match). FPS stays at the project default
        // (immutable after creation; we no longer create from media).
        if (ratio !== 'match') {
          try {
            var parts = ratio.split('x');
            var w = parseInt(parts[0]), h = parseInt(parts[1]);
            var settings = await seq.getSettings();
            if (settings && w && h) {
              var frameRect = await settings.getVideoFrameRect();
              frameRect.width  = w;
              frameRect.height = h;
              await settings.setVideoFrameRect(frameRect);
              // Use sacCommitTx so a throw is caught INSIDE lockedAccess (a raw throw
              // here can wedge/crash Premiere).
              await sacCommitTx(project, function(ca) {
                ca.addAction(seq.createSetSettingsAction(settings));
              }, 'SAC set frame size');
              console.log('[SAC] Frame size applied:', w + 'x' + h);
            }
          } catch(es) { console.warn('[SAC] Frame size failed:', es.message); }
        }

        try {
          if (typeof project.openSequence    === 'function') await project.openSequence(seq);
          if (typeof project.setActiveSequence === 'function') await project.setActiveSequence(seq);
        } catch (eOpen) { console.warn('[SAC] open/activate sequence:', eOpen && eOpen.message); }
        // Settle generously after activation before the editor + assembly run — a
        // freshly-created sequence that's touched too soon is a common crash cause.
        status.textContent = '⏳ Chờ sequence sẵn sàng...';
        await new Promise(function(r) { setTimeout(r, 900); });
        cursor = 0;
        console.log('[SAC] New sequence (empty):', seqName, '| ratio:', ratio);
      } else {
        seq    = await getActiveSequence();
        status.textContent = '⏳ Tìm vị trí cuối timeline...';
        cursor = await sacGetSequenceEnd(seq);
      }

      var seqEditor = ppro.SequenceEditor.getEditor(seq); // sync, no await
      if (!seqEditor) throw new Error('Không lấy được SequenceEditor');

      console.log('[SAC] Assembly start at', cursor.toFixed(2) + 's, blocks:', blocks.length,
        sacNoVoiceMode ? '(without voice)' : '');

      // Import voice file once — skip if Without Voice mode
      var voiceItem = null;
      if (!sacNoVoiceMode) {
        var voicePath = sacVoicePath || window.sacVoicePath;
        if (voicePath) {
          status.textContent = '⏳ Import voice...';
          try {
            voiceItem = await sacFindOrImportFile(voicePath);
            console.log('[SAC] Voice:', voiceItem ? 'ok' : 'not found in bin');
          } catch(e) { console.warn('[SAC] Voice import failed:', e.message); }
        }
      }

      // Pre-fetch real durations for full-clip sources (no timecode) so each is placed
      // at its ACTUAL length — not all clamped to one default window — and the cursor
      // advances correctly (no overlap, no bleed). Falls back to 5s if path/ffprobe fail.
      status.textContent = '⏳ Đọc độ dài clip...';
      var sacFullDur = {};
      for (var pbi = 0; pbi < blocks.length; pbi++) {
        var pbsrcs = blocks[pbi].sources || [];
        for (var psj = 0; psj < pbsrcs.length; psj++) {
          var pbs = pbsrcs[psj];
          if (pbs.skipped) continue;
          if (parseSourceTime(pbs.time).inSec !== null) continue; // has timecode
          if (sacFullDur[pbs.name] !== undefined) continue;        // already fetched
          var pit = (sacSourceMap[pbs.name] || window.sacSourceMap[pbs.name]);
          if (!pit) { sacFullDur[pbs.name] = 0; continue; }
          var mp = null;
          try {
            var pci = (ppro.ClipProjectItem && ppro.ClipProjectItem.cast) ? ppro.ClipProjectItem.cast(pit) : pit;
            mp = (pci || pit).getMediaFilePath && (pci || pit).getMediaFilePath();
            if (mp && typeof mp.then === 'function') mp = await mp;
          } catch(e) {}
          if (!mp || typeof mp !== 'string') { sacFullDur[pbs.name] = 0; continue; }
          try {
            var dr = await fetch(BRIDGE_URL + '/tts/duration', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ audioPath: mp }),
            });
            var dj = await dr.json();
            sacFullDur[pbs.name] = (dj && dj.ok && dj.duration > 0) ? dj.duration : 0;
          } catch(e) { sacFullDur[pbs.name] = 0; }
        }
      }

      var placed = 0;
      for (var i = 0; i < blocks.length; i++) {
        var block      = blocks[i];
        var blockStart = cursor;
        var srcTotal   = 0;
        status.textContent = '⏳ Block ' + (i + 1) + '/' + blocks.length + '...';

        // Place each source clip on V1 (video only), source audio → A2
        for (var j = 0; j < (block.sources || []).length; j++) {
          var src = block.sources[j];

          // Skip check MUST come before srcItem lookup — skipped sources have no item
          if (src.skipped) {
            console.log('[SAC] V1 "' + src.name + '" SKIPPED — 1s gap @' + cursor.toFixed(2) + 's');
            srcTotal += 1.0;
            cursor   += 1.0;
            continue;
          }

          var srcItem = (sacSourceMap[src.name] || window.sacSourceMap[src.name]);
          if (!srcItem) {
            // Missing & not skipped: leave a 1s gap rather than silently collapsing
            // (so the timeline still lines up with the script/voice).
            console.warn('[SAC] Missing source (gap):', src.name);
            srcTotal += 1.0;
            cursor   += 1.0;
            continue;
          }

          var ts = parseSourceTime(src.time);
          var inSec, outSec, label;
          if (ts.inSec !== null && ts.outSec !== null) {
            // Explicit timecode range from the cutsheet.
            inSec = ts.inSec; outSec = ts.outSec;
            label = '[' + inSec + '-' + outSec + ']s';
          } else {
            // No timecode parsed → place the WHOLE clip at its real length (pre-fetched).
            // Log the raw value so a still-unparsed timecode format is easy to spot.
            console.warn('[SAC] timecode KHÔNG parse được cho "' + src.name + '" — time thô = ' + JSON.stringify(src.time) + ' → dùng full clip');
            inSec = 0;
            var full = sacFullDur[src.name];
            outSec = (full && full > 0.15) ? (full - 0.05) : 5; // tiny margin to stay in media
            label = (full && full > 0) ? ('[full ' + outSec.toFixed(1) + 's]') : '[full ~5s]';
          }
          // Guard NaN/Infinity/âm/inverted — chặn clipDur=NaN làm cursor=NaN lan ra toàn assembly.
          if (!isFinite(inSec)  || inSec < 0)        inSec  = 0;
          if (!isFinite(outSec) || outSec <= inSec)  outSec = inSec + 0.5;
          var clipDur = outSec - inSec;
          if (!isFinite(clipDur) || clipDur < 0)      clipDur = 0.5;

          try {
            await sacInsertClipAt(project, seqEditor, srcItem, cursor, inSec, outSec, 0, 1);
            console.log('[SAC] V1 "' + src.name + '" ' + label + ' @' + cursor.toFixed(2) + 's');
          } catch (eClip) {
            // One bad clip must not abort the whole assembly (crash-hardening, #4).
            console.error('[SAC] insert failed for "' + src.name + '":', eClip && eClip.message);
          }

          srcTotal += clipDur;
          cursor   += clipDur;
        }

        // Place voice segment on A1 (skipped in Without Voice mode)
        if (!sacNoVoiceMode && voiceItem && block.voiceStart != null && block.voiceEnd != null) {
          var vStart = Math.max(0, Number(block.voiceStart));
          var vOut   = Number(block.voiceEnd) + 0.2;
          var vDur   = block.voiceDuration || (block.voiceEnd - block.voiceStart);
          // Guard against NaN / negative / inverted times that would crash TickTime.
          if (isFinite(vStart) && isFinite(vOut) && vOut > vStart) {
            try {
              await sacInsertClipAt(project, seqEditor, voiceItem, blockStart, vStart, vOut, 5, 0);
              console.log('[SAC] A1 voice [' + vStart.toFixed(2) + '-' + vOut.toFixed(2) + ']s @' + blockStart.toFixed(2) + 's');
              if (vDur > srcTotal) cursor = blockStart + vDur;
            } catch (eVoice) {
              console.error('[SAC] voice insert failed @block ' + (i + 1) + ':', eVoice && eVoice.message);
            }
          } else {
            console.warn('[SAC] skip voice @block ' + (i + 1) + ' — bad times', vStart, vOut);
          }
        }

        cursor += 1.0; // 1s gap between blocks
        placed++;
        await new Promise(function(r) { setTimeout(r, 300); });
      }

      // ── Show success panel ────────────────────────────────────────────────
      var statsEl = $('sacSuccessStats');
      if (statsEl) {
        statsEl.textContent = placed + ' blocks · ' + cursor.toFixed(1) + 's' +
          (sacNoVoiceMode ? ' · without voice' : '');
      }
      status.style.display = 'none';
      $('sacPanelManual').style.display = 'none';
      $('sacSuccessPanel').style.display = 'flex';

    } catch(e) {
      status.textContent = '❌ ' + e.message;
      console.error('[SAC] sacRunAutoCut error:', e);
    }
  }

  // ── Collapse/expand the script input section ─────────────────────────────
  // ── ✨ AI cutsheet parse (paste raw → AI → preview/edit → fill spreadsheet) ──
  var sacAiToggle = $('sacAiToggle');
  if (sacAiToggle) sacAiToggle.addEventListener('click', function() {
    var body = $('sacAiBody');
    var open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    $('sacAiChevron').textContent = open ? '▸' : '▾';
  });
  ['sacAiRaw', 'sacAiPreview'].forEach(function(id) {
    var ta = $(id);
    if (!ta) return;
    ta.addEventListener('focus', function() { if (window.claimKeyboard) window.claimKeyboard(); });
    ta.addEventListener('blur',  function() { if (window.releaseKeyboard) window.releaseKeyboard(); });
  });
  // Model picker (shared with VoiceGen Organize via ORGANIZE_MODEL). Claude → runs
  // via CLI (no key needed); Gemini → needs a Gemini key.
  var sacAiModel = $('sacAiModel');
  if (sacAiModel) {
    sacAiModel.value = sacResolveOrganizeModel(); // Gemini nếu có key, else Sonnet (hoặc pick của user)
    sacAiModel.addEventListener('change', function() {
      ORGANIZE_MODEL = sacAiModel.value;
      localStorage.setItem('sac_organize_model', ORGANIZE_MODEL);
      var vg = document.getElementById('vgOrganizeModel'); if (vg) vg.value = ORGANIZE_MODEL; // keep in sync
    });
  }
  var sacAiParseBtn = $('sacAiParseBtn');
  if (sacAiParseBtn) sacAiParseBtn.addEventListener('click', async function() {
    var raw = ($('sacAiRaw').value || '').trim();
    var st  = $('sacAiStatus');
    if (!raw) { if (st) st.textContent = 'Dán cutsheet vào đã.'; return; }
    var cfg = window.sacOrganizeConfig ? window.sacOrganizeConfig() : { provider: 'anthropic', model: null, apiKey: '' };
    sacAiParseBtn.disabled = true;
    if (st) st.textContent = '⏳ AI đang phân tích (' + cfg.model + ')...';
    try {
      var resp = await fetch(BRIDGE_URL + '/superautocut/parse-cutsheet', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: raw, provider: cfg.provider, model: cfg.model, apiKey: cfg.apiKey }),
      });
      var d = await resp.json();
      if (d.ok && Array.isArray(d.rows) && d.rows.length) {
        var pv = $('sacAiPreview');
        pv.value = d.rows.map(function(r) { return [r.text || '', r.time || '', r.source || ''].join('\t'); }).join('\n');
        pv.style.display = ''; $('sacAiFill').style.display = '';
        if (st) st.textContent = '✓ ' + d.rows.length + ' dòng — kiểm tra/sửa (Thoại ⇥ Time ⇥ Source) rồi "Đổ vào bảng".';
      } else {
        if (st) st.textContent = '✗ ' + (d.error || 'AI không trả được dòng nào');
      }
    } catch(e) { if (st) st.textContent = '✗ Bridge lỗi: ' + e.message; }
    finally { sacAiParseBtn.disabled = false; }
  });
  var sacAiFill = $('sacAiFill');
  if (sacAiFill) sacAiFill.addEventListener('click', function() {
    var pv = $('sacAiPreview');
    var lines = (pv.value || '').split('\n').map(function(l) { return l.replace(/\r$/, ''); }).filter(function(l) { return l.trim(); });
    if (!lines.length) return;
    $('sacBody').innerHTML = ''; rowSeq = 0;
    lines.forEach(function(l) {
      var cols = l.split('\t');
      createRow((cols[0] || '').trim(), (cols[1] || '').trim(), (cols[2] || '').trim());
    });
    parsedBlocks = [];
    // Collapse the AI section, open the script editor so the user sees the result.
    $('sacAiBody').style.display = 'none'; $('sacAiChevron').textContent = '▸';
    $('sacTableWrap').style.display = ''; $('sacTableFooter').style.display = '';
    $('sacScriptChevron').textContent = '▾';
    var st = $('sacAiStatus'); if (st) st.textContent = '✓ Đã đổ ' + lines.length + ' dòng vào bảng — bấm Validate.';
  });

  var sacScriptToggle = $('sacScriptToggle');
  if (sacScriptToggle) {
    sacScriptToggle.addEventListener('click', function() {
      var wrap = $('sacTableWrap');
      var footer = $('sacTableFooter');
      var wasCollapsed = wrap.style.display === 'none';
      wrap.style.display   = wasCollapsed ? '' : 'none';
      footer.style.display = wasCollapsed ? '' : 'none';
      $('sacScriptChevron').textContent = wasCollapsed ? '▾' : '▸';
      // When script is hidden, let the blocks section grow to fill the panel.
      // (default is a fixed 220px height — see .sac-blockSection)
      $('sacBlockSection').style.flex = wasCollapsed ? '' : '1 1 0';
    });
  }

  // 🗑 Clear (in the script header, visible even when collapsed): wipe the whole
  // script AND cancel any running normalize / validate, then re-open the editor.
  var sacScriptClearBtn = $('sacScriptClear');
  if (sacScriptClearBtn) sacScriptClearBtn.addEventListener('click', function(e) {
    e.stopPropagation(); // don't toggle collapse
    sacCancelNorm();           // abort in-flight normalize
    sacValidateToken++;        // invalidate in-flight validate
    try { sacVPStop(); } catch(err) {}
    // Wipe the board
    $('sacBody').innerHTML = '';
    rowSeq = 0;
    createRow(); createRow(); createRow();
    // Reset derived state
    parsedBlocks = [];
    sacBindOverrides = {};
    sacValidatePassed = false;
    sacVoiceReady = false;
    sacNoVoiceMode = false;
    sacVoicePath = null;
    sacMarkScriptPrepared(false);
    // Hide blocks + cut panel, reset voice
    $('sacBlockSection').style.display = 'none';
    sacHideCutPanel();
    var vi = $('sacVoiceInfo'); if (vi) vi.textContent = 'Chưa có voice';
    var vp = $('sacVoicePlayer'); if (vp) vp.style.display = 'none';
    // Re-open the script editor
    $('sacTableWrap').style.display = '';
    $('sacTableFooter').style.display = '';
    $('sacScriptChevron').textContent = '▾';
    $('sacBlockSection').style.flex = '';
    var st = $('sacStatus'); if (st) { st.textContent = '🗑 Đã clear script + huỷ tác vụ đang chạy.'; st.style.display = 'block'; }
    if (typeof sacUpdateRunVisibility === 'function') sacUpdateRunVisibility();
  });

  // ── Init: 3 empty rows ───────────────────────────────────────────────────
  createRow(); createRow(); createRow();

})(); // END Super Auto Cut module

// ═══════════════════════════════════════════════════════════════════════════
// VOICE GEN MODULE (ElevenLabs)
// ═══════════════════════════════════════════════════════════════════════════
(function() {
  var $ = function(id) { return document.getElementById(id); };
  var els = {
    statusDot:    $('vgStatusDot'),
    statusText:   $('vgStatusText'),
    btnRefresh:   $('vgRefreshVoices'),
    voiceSelect:  $('vgVoiceSelect'),
    customVoiceId: $('vgCustomVoiceId'),
    voiceSource:  $('vgVoiceSource'),
    modelSelect:  $('vgModelSelect'),
    script:       $('vgScript'),
    charCount:    $('vgCharCount'),
    outputFolder: $('vgOutputFolder'),
    btnBrowseFolder: $('vgBrowseFolder'),
    btnResetFolder:  $('vgResetFolder'),
    filename:     $('vgFilename'),
    twoVariations: $('vg2Variations'),
    btnGenerate:  $('vgGenerate'),
    resultSection: $('vgResultSection'),
    var1:         $('vgVar1'),
    var1Size:     $('vgVar1Size'),
    var1Import:   $('vgVar1Import'),
    var2:         $('vgVar2'),
    var2Size:     $('vgVar2Size'),
    var2Import:   $('vgVar2Import'),
    importStatus: $('vgImportStatus'),
  };

  var voicesLoaded = false;
  // Restore the last save folder so imports remember it across sessions (see importVariation).
  var customOutputFolder = localStorage.getItem('vg_last_save_folder') || '';
  if (customOutputFolder && els.outputFolder) els.outputFolder.value = customOutputFolder;
  var lastVariations = []; // [{audioPath, previewUrl, sizeBytes, filename}, ...]
  var currentMode = 'tts'; // 'tts' | 'sfx' | 'music'
  var players = {}; // { var1: {audio, isPlaying}, var2: {...} }

  // ── Multi-speaker state ─────────────────────────────────────────────────
  var VG_SPEAKER_COLORS = ['#a855f7','#3b82f6','#22c55e','#f59e0b','#ef4444','#06b6d4'];
  var VG_SPEAKERS = [
    { id: 's1', voiceId: '21m00Tcm4TlvDq8ikWAM', voiceName: 'Rachel', color: '#a855f7' }
  ];
  var VG_ACTIVE_SPEAKER = 's1';
  var VG_SPEAKER_TEXTS = { s1: '' };
  var VG_PREVIEW_URLS  = {}; // voiceId → ElevenLabs CDN preview_url string
  var VG_PREVIEW_CACHE = {}; // voiceId → local bridge URL (cached after first fetch)
  var VG_VOICES_DATA   = []; // { voice_id, label, preview_url, isCustom, isSep }
  var vgCurrentVoiceId = ''; // source of truth for the picked voice (UXP <select>.value is unreliable)
  var VG_DROP_BTNS     = {}; // voiceId → ▶ button DOM element in dropdown
  var VG_PREV_ACTIVE   = null; // voiceId currently being previewed
  var vgDropResizeHandler = null; // window resize handler while dropdown is open

  function saveCurrentSpeakerText() {
    if (els.script) {
      var v = els.script.value;
      VG_SPEAKER_TEXTS[VG_ACTIVE_SPEAKER] = (v == null ? '' : String(v));
    }
    var sp = VG_SPEAKERS.find(function(s) { return s.id === VG_ACTIVE_SPEAKER; });
    if (sp) {
      sp.voiceId = vgCurrentVoiceId || (els.voiceSelect && els.voiceSelect.value) || sp.voiceId;
      sp.voiceName = vgVoiceName(sp.voiceId);
    }
  }

  function renderSpeakerBar() {
    var bar = $('vgSpeakerBar');
    if (!bar) return;
    var addBtn = $('vgAddSpeaker');
    // Remove all speaker tabs (keep addBtn)
    var tabs = bar.querySelectorAll('.vg-speakerTab');
    tabs.forEach(function(t) { bar.removeChild(t); });

    VG_SPEAKERS.forEach(function(sp) {
      // Use <div role="button"> instead of <button> to avoid UXP nested-button bug
      // (UXP Chromium doesn't fire click on a <button> nested inside another <button>)
      var tab = document.createElement('div');
      tab.className = 'vg-speakerTab' + (sp.id === VG_ACTIVE_SPEAKER ? ' is-active' : '');
      tab.setAttribute('role', 'button');
      tab.setAttribute('tabindex', '0');
      tab.dataset.speakerId = sp.id;
      tab.style.setProperty('--sp-color', sp.color);

      var nameSpan = document.createElement('span');
      nameSpan.textContent = sp.voiceName;
      tab.appendChild(nameSpan);

      if (VG_SPEAKERS.length > 1) {
        var rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'vg-speakerRemove';
        rm.textContent = '×';
        (function(spId) {
          rm.addEventListener('click', function(e) {
            e.stopPropagation();
            e.preventDefault();
            removeSpeaker(spId);
          });
        })(sp.id);
        tab.appendChild(rm);
      }

      (function(spId) {
        tab.addEventListener('click', function(e) {
          // Ignore if the remove button was clicked (stopPropagation may not fire first in UXP)
          if (e.target && e.target.classList && e.target.classList.contains('vg-speakerRemove')) return;
          switchSpeaker(spId);
        });
        tab.addEventListener('keydown', function(e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchSpeaker(spId); }
        });
      })(sp.id);

      bar.insertBefore(tab, addBtn);
    });
  }

  function switchSpeaker(newId) {
    saveCurrentSpeakerText();
    VG_ACTIVE_SPEAKER = newId;
    var sp = VG_SPEAKERS.find(function(s) { return s.id === newId; });
    if (sp) {
      if (els.script) { els.script.value = VG_SPEAKER_TEXTS[newId] || ''; vgAutoResize(els.script); }
      vgSetVoice(sp.voiceId);
    }
    renderSpeakerBar();
  }

  function addSpeaker() {
    saveCurrentSpeakerText();
    var newId = 's' + Date.now();
    var colorIdx = VG_SPEAKERS.length % VG_SPEAKER_COLORS.length;
    VG_SPEAKERS.push({
      id: newId,
      voiceId: 'pNInz6obpgDQGcFmaJgB', // Adam — distinct default second voice
      voiceName: 'Adam',
      color: VG_SPEAKER_COLORS[colorIdx],
    });
    VG_SPEAKER_TEXTS[newId] = '';
    switchSpeaker(newId);
  }

  function removeSpeaker(id) {
    if (VG_SPEAKERS.length <= 1) return;
    var idx = VG_SPEAKERS.findIndex(function(s) { return s.id === id; });
    if (idx < 0) return;
    VG_SPEAKERS.splice(idx, 1);
    delete VG_SPEAKER_TEXTS[id];
    if (VG_ACTIVE_SPEAKER === id) {
      switchSpeaker(VG_SPEAKERS[Math.max(0, idx - 1)].id);
    } else {
      renderSpeakerBar();
    }
  }

  // ── Audio engine: delegate to bridge (afplay on macOS) ───────────────────
  // UXP has no HTMLMediaElement and no AudioContext — the bridge runs afplay
  // and holds the HTTP connection open until playback finishes. Aborting the
  // fetch from the plugin side auto-signals the bridge to kill afplay via
  // a concurrent /tts/stop call.
  var vgIsPlaying    = false;
  var vgAbortCtrl    = null;
  var vgOnStopCb     = null;

  // url must be a full URL like http://localhost:3030/tts/audio/xxx.mp3
  // onEnd() fires when playback ends naturally OR is stopped.
  // onError(msg) fires on bridge/network errors.
  // onProgress is accepted but unused (no seek support via afplay).
  function vgPlayUrl(url, onProgress, onEnd, onError) {
    // Stop previous without sending /tts/stop — new /tts/play will kill old process
    if (vgAbortCtrl) { vgAbortCtrl.abort(); vgAbortCtrl = null; }
    if (vgOnStopCb)  { var prev = vgOnStopCb; vgOnStopCb = null; prev(); }
    vgIsPlaying = false;

    var relUrl = url.startsWith(BRIDGE_URL) ? url.slice(BRIDGE_URL.length) : url;
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    vgAbortCtrl  = ctrl;
    vgOnStopCb   = onEnd || null;
    vgIsPlaying  = true;

    fetch(BRIDGE_URL + '/tts/play', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ audioUrl: relUrl }),
      signal:  ctrl ? ctrl.signal : undefined,
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!vgIsPlaying) return; // already stopped by user
        vgIsPlaying  = false;
        vgAbortCtrl  = null;
        var cb = vgOnStopCb; vgOnStopCb = null;
        if (cb) cb();
      })
      .catch(function(e) {
        if (e && e.name === 'AbortError') return; // intentional stop — onEnd already called
        vgIsPlaying = false;
        vgAbortCtrl = null;
        vgOnStopCb  = null;
        console.error('[vgPlayUrl]', relUrl, e);
        if (onError) onError(e.message || String(e));
      });
  }

  // Play an absolute file path directly — no temp-dir HTTP serving needed.
  // startOffset (optional): seconds to seek to before playing (uses ffplay on bridge).
  function vgPlayPath(absPath, onProgress, onEnd, onError, startOffset) {
    if (vgAbortCtrl) { vgAbortCtrl.abort(); vgAbortCtrl = null; }
    if (vgOnStopCb)  { var prev = vgOnStopCb; vgOnStopCb = null; prev(); }
    vgIsPlaying = false;
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    vgAbortCtrl = ctrl;
    vgOnStopCb  = onEnd || null;
    vgIsPlaying = true;
    var body = { filePath: absPath };
    if (startOffset > 0) body.startOffset = startOffset;
    fetch(BRIDGE_URL + '/tts/play', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  ctrl ? ctrl.signal : undefined,
    })
      .then(function(r) { return r.json(); })
      .then(function() {
        if (!vgIsPlaying) return;
        vgIsPlaying = false; vgAbortCtrl = null;
        var cb = vgOnStopCb; vgOnStopCb = null; if (cb) cb();
      })
      .catch(function(e) {
        if (e && e.name === 'AbortError') return;
        vgIsPlaying = false; vgAbortCtrl = null; vgOnStopCb = null;
        if (onError) onError(e.message || String(e));
      });
  }


  function vgStopAll() {
    if (!vgIsPlaying && !vgAbortCtrl) return;
    if (vgAbortCtrl) { vgAbortCtrl.abort(); vgAbortCtrl = null; }
    vgIsPlaying = false;
    var cb = vgOnStopCb; vgOnStopCb = null;
    if (cb) cb();
    // Tell bridge to kill afplay
    fetch(BRIDGE_URL + '/tts/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).catch(function() {});
  }

  // ── Player factory ────────────────────────────────────────────────────────
  function createPlayer(slot) {
    var prefix = 'vgV' + (slot === 'var1' ? 'ar1' : 'ar2');
    var playBtn  = $(prefix + 'Play');
    var progWrap = $(prefix + 'ProgWrap');
    var fill     = $(prefix + 'Fill');
    var timeEl   = $(prefix + 'Time');
    var currentPath = null;
    var isPlaying   = false;
    var duration    = 0;
    var startedAt   = 0;
    var startOffset = 0;
    var ticker      = null;

    function fmt(s) {
      if (!isFinite(s) || s < 0) s = 0;
      var m = Math.floor(s / 60), sec = Math.floor(s % 60);
      return m + ':' + (sec < 10 ? '0' : '') + sec;
    }
    function updateTick() {
      var elapsed = startOffset + (Date.now() - startedAt) / 1000;
      if (duration > 0 && elapsed > duration) elapsed = duration;
      timeEl.textContent = fmt(elapsed) + ' / ' + fmt(duration);
      fill.style.width = duration > 0 ? (elapsed / duration * 100).toFixed(1) + '%' : '0%';
    }
    function stopTicker() {
      if (ticker) { clearInterval(ticker); ticker = null; }
    }
    function setPlaying(val) {
      isPlaying = val;
      piSetBtn(playBtn, val ? 'pause' : 'play');
      if (!val) stopTicker();
    }
    function doPlay(offset) {
      offset = offset || 0;
      startOffset = offset;
      startedAt   = Date.now();
      setPlaying(true);
      ticker = setInterval(updateTick, 200);
      vgPlayPath(currentPath, null,
        function() {
          setPlaying(false);
          fill.style.width = duration > 0 ? '100%' : '0%';
          timeEl.textContent = fmt(duration) + ' / ' + fmt(duration);
        },
        function(e) { setPlaying(false); timeEl.textContent = 'error'; console.warn('[VG player ' + slot + ']', e); },
        offset
      );
    }

    playBtn.addEventListener('click', function() {
      if (!currentPath) return;
      if (isPlaying) { vgStopAll(); return; }
      doPlay(0);
    });

    if (progWrap) {
      progWrap.addEventListener('click', function(e) {
        if (!currentPath || duration <= 0) return;
        var rect = progWrap.getBoundingClientRect();
        var frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        var offset = frac * duration;
        if (isPlaying) { vgStopAll(); stopTicker(); setPlaying(false); }
        setTimeout(function() { doPlay(offset); }, 60);
      });
    }

    return {
      setSrc: function(absPath) {
        if (isPlaying) { vgStopAll(); setPlaying(false); }
        stopTicker();
        currentPath = absPath;
        duration = 0;
        fill.style.width = '0%';
        timeEl.textContent = '0:00 / ?';
        fetch(BRIDGE_URL + '/tts/duration', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioPath: absPath }),
        }).then(function(r) { return r.json(); }).then(function(d) {
          if (d.ok && d.duration > 0) {
            duration = d.duration;
            timeEl.textContent = '0:00 / ' + fmt(duration);
          }
        }).catch(function() {});
      },
    };
  }

  function setStatus(text, ok) {
    els.statusText.textContent = text;
    if (ok) els.statusDot.classList.add('is-ok');
    else    els.statusDot.classList.remove('is-ok');
  }

  // (sliders + meta are wired via hookSlider below — this just refreshes the meta line)
  // UXP textarea .value can be null when empty — guard
  function safeLen(el) {
    if (!el) return 0;
    var v = el.value;
    if (v == null) return 0;
    return String(v).length;
  }
  function updateCharCount() {
    if (!els.charCount) return;
    var n = safeLen(els.script);
    els.charCount.textContent = n + ' / 5000';
    els.charCount.style.color = n > 5000 ? 'var(--error)' : '';
  }

  // Try to load voices from user's ElevenLabs account.
  // Falls back gracefully if key is TTS-restricted (no voices_read perm).
  // ── Helpers ──────────────────────────────────────────────────────────────
  function vgVoiceName(voiceId) {
    voiceId = voiceId || vgCurrentVoiceId;
    var v = VG_VOICES_DATA.find(function(x) { return !x.isSep && x.voice_id === voiceId; });
    if (v) return v.label.replace(/^⭐\s*/, '').split(' · ')[0];
    var opt = els.voiceSelect ? els.voiceSelect.options[els.voiceSelect.selectedIndex] : null;
    return opt ? opt.textContent.replace(/^⭐\s*/, '').split(' · ')[0] : 'Voice';
  }

  function vgSetVoice(voiceId) {
    vgCurrentVoiceId = voiceId; // remember reliably (UXP select.value may not stick)
    if (els.voiceSelect) els.voiceSelect.value = voiceId;
    var v = VG_VOICES_DATA.find(function(x) { return !x.isSep && x.voice_id === voiceId; });
    var label = v ? v.label : (els.voiceSelect && els.voiceSelect.options[els.voiceSelect.selectedIndex]
      ? els.voiceSelect.options[els.voiceSelect.selectedIndex].textContent : voiceId);
    var labelEl = $('vgVoiceDropLabel');
    if (labelEl) labelEl.textContent = label.replace(/^⭐\s*/, '');
    if (els.customVoiceId) els.customVoiceId.hidden = voiceId !== '__custom__';
  }

  // ── Custom voice dropdown ────────────────────────────────────────────────
  function renderVoiceDrop() {
    var panel = $('vgVoiceDropPanel');
    if (!panel) return;
    panel.innerHTML = '';
    VG_DROP_BTNS = {};
    var currentId = els.voiceSelect ? els.voiceSelect.value : '';

    // Search row
    var searchWrap = document.createElement('div');
    searchWrap.className = 'vg-dropSearch';
    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'vg-dropSearchInput';
    searchInput.placeholder = 'Search voices…';
    searchWrap.appendChild(searchInput);
    panel.appendChild(searchWrap);

    // Scrollable list container
    var listEl = document.createElement('div');
    listEl.className = 'vg-dropList';
    panel.appendChild(listEl);

    // Pre-render all items once. Filtering only toggles display — no innerHTML
    // rebuild on each keystroke, so UXP never resets the input's focus/selection.
    var _allItems = [];
    VG_VOICES_DATA.forEach(function(v) {
      if (v.isSep) {
        var sep = document.createElement('div');
        sep.className = 'vg-dropSep';
        sep.textContent = '── Default voices ──';
        listEl.appendChild(sep);
        _allItems.push({ el: sep, isSep: true });
        return;
      }

      var item = document.createElement('div');
      item.className = 'vg-dropItem' + (v.voice_id === currentId ? ' is-selected' : '');

      var info = document.createElement('div');
      info.className = 'vg-dropItemLabel';
      info.textContent = (v.isCustom ? '⭐ ' : '') + v.label;
      item.appendChild(info);

      if (v.voice_id !== '__custom__') {
        var btn = document.createElement('div');
        btn.className = 'vg-dropItemPrev';
        btn.setAttribute('role', 'button');
        piMakeButton(btn);
        piSetBtn(btn, 'play');
        VG_DROP_BTNS[v.voice_id] = btn;
        (function(vid, b) {
          b.addEventListener('click', function(e) {
            e.stopPropagation();
            vgPreviewItem(vid, b);
          });
        })(v.voice_id, btn);
        item.appendChild(btn);
      }

      info.addEventListener('click', function() { vgDropSelect(v.voice_id, v.label); });
      listEl.appendChild(item);
      _allItems.push({ el: item, isSep: false, label: v.label });
    });

    function buildList(filter) {
      var f = (filter || '').toLowerCase().trim();
      _allItems.forEach(function(entry) {
        if (entry.isSep) { entry.el.style.display = f ? 'none' : ''; return; }
        entry.el.style.display = (!f || entry.label.toLowerCase().indexOf(f) !== -1) ? '' : 'none';
      });
    }

    // claimKeyboard is managed at the dropdown open/close level (openVoiceDrop /
    // closeVoiceDrop) to avoid repeated setKeyboardFocus(true) calls from phantom
    // focus events that UXP fires during layout — each call could trigger select-all.
    var _composing = false;
    searchInput.addEventListener('compositionstart', function() { _composing = true; });
    searchInput.addEventListener('compositionend', function() { _composing = false; buildList(searchInput.value); });
    searchInput.addEventListener('input', function() { if (!_composing) buildList(searchInput.value); });
  }

  function repositionVoiceDrop() {
    var panel = $('vgVoiceDropPanel');
    var trigger = $('vgVoiceDropTrigger');
    var container = document.getElementById('tab-voicegen');
    if (!panel || !trigger || !container) return;
    var triggerRect = trigger.getBoundingClientRect();
    var contRect    = container.getBoundingClientRect();
    panel.style.top   = (triggerRect.bottom - contRect.top)  + 'px';
    panel.style.left  = (triggerRect.left   - contRect.left) + 'px';
    panel.style.width = triggerRect.width + 'px';
  }

  function openVoiceDrop() {
    var panel = $('vgVoiceDropPanel');
    var trigger = $('vgVoiceDropTrigger');
    if (!panel || !trigger) return;
    repositionVoiceDrop();
    panel.style.maxHeight = '240px';
    panel.style.display  = 'flex';
    trigger.classList.add('is-open');
    if (!vgDropResizeHandler) {
      vgDropResizeHandler = function() { repositionVoiceDrop(); };
      window.addEventListener('resize', vgDropResizeHandler);
    }
    // Claim keyboard once here so Premiere doesn't intercept keys while dropdown
    // is open. Doing it on the input's focus event caused repeated calls during
    // UXP layout reflows (each call may trigger select-all on the input).
    window.claimKeyboard();
    var si = panel.querySelector('.vg-dropSearchInput');
    if (si) setTimeout(function() { try { si.focus(); } catch(e) {} }, 30);
  }

  function closeVoiceDrop() {
    var panel = $('vgVoiceDropPanel');
    var trigger = $('vgVoiceDropTrigger');
    if (panel) panel.style.display = 'none';
    if (trigger) trigger.classList.remove('is-open');
    if (vgDropResizeHandler) {
      window.removeEventListener('resize', vgDropResizeHandler);
      vgDropResizeHandler = null;
    }
    window.releaseKeyboard();
    if (VG_PREV_ACTIVE) { vgStopAll(); }
  }

  function vgDropSelect(voiceId, label) {
    vgSetVoice(voiceId);
    closeVoiceDrop();
    // Fire change on hidden select so existing listeners react
    var evt = document.createEvent('Event');
    evt.initEvent('change', true, true);
    if (els.voiceSelect) els.voiceSelect.dispatchEvent(evt);
  }

  // ── Per-item voice preview ───────────────────────────────────────────────
  function vgPreviewItem(voiceId, btn) {
    if (!ELEVENLABS_KEY) { setStatus('Need ElevenLabs key', false); return; }

    // Same voice playing → stop
    if (VG_PREV_ACTIVE === voiceId) {
      vgStopAll();
      return;
    }
    // Different voice was playing → reset its button
    if (VG_PREV_ACTIVE) {
      var oldBtn = VG_DROP_BTNS[VG_PREV_ACTIVE];
      if (oldBtn) { piSetBtn(oldBtn, 'play'); oldBtn.classList.remove('is-playing'); }
      vgStopAll();
    }

    var url = VG_PREVIEW_CACHE[voiceId];
    if (url) {
      vgStartPreviewPlay(voiceId, btn, url);
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '…';

    (async function() {
      try {
        if (VG_PREVIEW_URLS[voiceId]) {
          var pvResp = await postJsonVG('/tts/voice-preview', {
            previewUrl: VG_PREVIEW_URLS[voiceId], voiceId: voiceId,
          });
          if (!pvResp.ok) throw new Error(pvResp.error || 'preview fetch failed');
          url = BRIDGE_URL + pvResp.previewUrl;
        } else {
          var resp = await postJsonVG('/tts/generate', {
            apiKey: ELEVENLABS_KEY, voiceId: voiceId,
            modelId: 'eleven_turbo_v2_5',
            text: 'Hello, this is a voice sample.',
            variations: 1, filename: 'preview-' + voiceId,
          });
          if (!resp.ok || !resp.variations || !resp.variations[0])
            throw new Error(resp.error || 'preview failed');
          url = BRIDGE_URL + resp.variations[0].previewUrl;
        }
        VG_PREVIEW_CACHE[voiceId] = url;
        btn.disabled = false;
        vgStartPreviewPlay(voiceId, btn, url);
      } catch(e) {
        btn.disabled = false;
        piSetBtn(btn, 'play');
        VG_PREV_ACTIVE = null;
        setStatus('Preview: ' + e.message, false);
      }
    })();
  }

  function vgStartPreviewPlay(voiceId, btn, url) {
    VG_PREV_ACTIVE = voiceId;
    piSetBtn(btn, 'pause');
    btn.classList.add('is-playing');
    vgPlayUrl(url, null,
      function() {
        if (VG_PREV_ACTIVE === voiceId) VG_PREV_ACTIVE = null;
        piSetBtn(btn, 'play');
        btn.classList.remove('is-playing');
      },
      function(e) {
        if (VG_PREV_ACTIVE === voiceId) VG_PREV_ACTIVE = null;
        piSetBtn(btn, 'play');
        btn.classList.remove('is-playing');
        console.warn('[vgPreview]', e);
      }
    );
  }

  async function loadVoices() {
    if (!ELEVENLABS_KEY) {
      setStatus('Set ElevenLabs API key in Settings ⚙', false);
      els.voiceSource.textContent = 'defaults (no key)';
      return;
    }
    setStatus('Loading voices...', false);
    try {
      var resp = await postJsonVG('/tts/voices', { apiKey: ELEVENLABS_KEY });
      if (!resp.ok) throw new Error(resp.error || 'load failed');
      var userVoices = resp.voices || [];

      // Rebuild VG_VOICES_DATA: user voices first, then separator, then defaults
      var defaults = VG_VOICES_DATA.filter(function(v) { return v.isDefault; });
      VG_VOICES_DATA = [];
      // Also rebuild hidden select
      var defaultSelectHtml = els.voiceSelect ? els.voiceSelect.innerHTML : '';
      if (els.voiceSelect) els.voiceSelect.innerHTML = '';

      userVoices.forEach(function(v) {
        if (v.preview_url) VG_PREVIEW_URLS[v.voice_id] = v.preview_url;
        var parts = [v.name];
        if (v.labels && v.labels.gender) parts.push(v.labels.gender);
        if (v.labels && v.labels.accent) parts.push(v.labels.accent);
        var label = parts.join(' · ');
        VG_VOICES_DATA.push({ voice_id: v.voice_id, label: label, preview_url: v.preview_url || '', isCustom: true });
        if (els.voiceSelect) {
          var opt = document.createElement('option');
          opt.value = v.voice_id; opt.textContent = '⭐ ' + label;
          els.voiceSelect.appendChild(opt);
        }
      });

      if (userVoices.length > 0) {
        VG_VOICES_DATA.push({ isSep: true });
        if (els.voiceSelect) {
          var sepOpt = document.createElement('option');
          sepOpt.disabled = true; sepOpt.textContent = '── Default voices ──';
          els.voiceSelect.appendChild(sepOpt);
        }
      }
      defaults.forEach(function(v) { VG_VOICES_DATA.push(v); });
      if (els.voiceSelect) {
        var tmp = document.createElement('div');
        tmp.innerHTML = defaultSelectHtml;
        Array.prototype.forEach.call(tmp.children, function(c) { els.voiceSelect.appendChild(c); });
      }

      renderVoiceDrop();
      voicesLoaded = true;

      if (userVoices.length === 0) {
        setStatus('✓ Key OK (TTS only) · using default voices', true);
        els.voiceSource.textContent = 'defaults';
      } else {
        setStatus('✓ ' + userVoices.length + ' custom + 25 default voices', true);
        els.voiceSource.textContent = 'custom + defaults';
      }
    } catch(e) {
      console.warn('[VoiceGen] voices fetch failed (expected for TTS-only keys):', e.message);
      setStatus('✓ Using default voices (key TTS-restricted)', true);
      els.voiceSource.textContent = 'defaults';
      voicesLoaded = true;
    }
  }

  function postJsonVG(endpoint, body) {
    return new Promise(function(resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', BRIDGE_URL + endpoint, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.timeout = 120000;
      xhr.onload = function() {
        try {
          var data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new Error(data.error || ('HTTP ' + xhr.status)));
        } catch(e) { reject(new Error('Invalid response: ' + xhr.responseText.slice(0,200))); }
      };
      xhr.onerror = function() { reject(new Error('Bridge offline')); };
      xhr.ontimeout = function() { reject(new Error('Bridge timeout (2 min)')); };
      xhr.send(JSON.stringify(body));
    });
  }

  function safeVal(el) {
    if (!el) return '';
    var v = el.value;
    return (v == null) ? '' : String(v).trim();
  }

  function getTtsSettings() {
    return {}; // eleven_v3 ignores voice_settings — always empty
  }

  // MMDDHHmmss — 10 chars, second-level uniqueness, e.g. "0528143052"
  function genTimestamp() {
    var d = new Date();
    var p = function(n) { return ('0' + n).slice(-2); };
    return p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function safeFileStr(s) {
    return (s || '').replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  }

  async function generateMultiSpeaker(numVar, userFilename, outputFmt) {
    saveCurrentSpeakerText();
    var active = VG_SPEAKERS.filter(function(sp) {
      return (VG_SPEAKER_TEXTS[sp.id] || '').trim();
    });
    if (active.length === 0) return setStatus('All speakers have empty text', false);

    els.btnGenerate.disabled = true;
    var resultCards = [];
    var ts = genTimestamp();
    var userSuffix = safeFileStr(userFilename);
    try {
      for (var i = 0; i < active.length; i++) {
        var sp = active[i];
        var spVoice = safeFileStr(sp.voiceName.split(' ')[0]) || 'voice';
        var spName = spVoice + (userSuffix ? '_' + userSuffix : '') + '_' + ts + (active.length > 1 ? '-' + (i + 1) : '');
        piSetBtn(els.btnGenerate, 'rotate_right', sp.voiceName + ' (' + (i + 1) + '/' + active.length + ')...', '#ffffff', 14);
        setStatus('Generating ' + sp.voiceName + '...', false);
        var resp = await postJsonVG('/tts/generate', {
          apiKey: ELEVENLABS_KEY,
          voiceId: sp.voiceId,
          modelId: els.modelSelect.value,
          text: VG_SPEAKER_TEXTS[sp.id],
          filename: spName,
          variations: numVar,
          outputFormat: outputFmt,
          settings: getTtsSettings(),
          languageCode: getLangCode(),
          outputDir: '', // always temp (11Lab temp); only move to the chosen folder on Import
        });
        if (!resp.ok) throw new Error(sp.voiceName + ': ' + (resp.error || 'failed'));
        resultCards.push({ speaker: sp, variations: resp.variations || [] });
      }
      renderMultiResults(resultCards);
      setStatus('✓ Generated ' + active.length + ' speakers', true);
    } catch(e) {
      setStatus('✗ ' + e.message, false);
    } finally {
      els.btnGenerate.disabled = false;
      piSetBtn(els.btnGenerate, 'bolt', 'GENERATE VOICE', '#ffffff', 14);
    }
  }

  function getLangCode() {
    var toggle = $('vgLangOverride');
    if (!toggle || !toggle.checked) return undefined;
    var sel = $('vgLangSelect');
    return (sel && sel.value) ? sel.value : undefined;
  }

  async function generate() {
    if (!ELEVENLABS_KEY) {
      setStatus('Set ElevenLabs API key in Settings first', false);
      return;
    }
    var numVar = els.twoVariations.checked ? 2 : 1;
    var outputFmt = ($('vgOutputFormat') && $('vgOutputFormat').value) || 'mp3_44100_128';

    // ── Default filename = voice name as prefix (user can override) ────────
    var userFilename = safeVal(els.filename);

    var endpoint, body, label;
    if (currentMode === 'tts') {
      saveCurrentSpeakerText();
      if (VG_SPEAKERS.length > 1) {
        // Multi-speaker: each speaker uses its own voice name as filename prefix
        return await generateMultiSpeaker(numVar, userFilename || undefined, outputFmt);
      }
      var voiceId = vgCurrentVoiceId || els.voiceSelect.value || '';
      if (voiceId === '__custom__') voiceId = safeVal(els.customVoiceId);
      if (!voiceId) return setStatus('Pick a voice', false);
      var text = safeVal(els.script);
      if (!text) return setStatus('Script is empty', false);
      // Voice name = prefix. Resolve via vgVoiceName(voiceId) (looks up VG_VOICES_DATA by
      // id) — NOT via selectedIndex: UXP doesn't update selectedIndex when .value is set
      // programmatically by the custom dropdown, so the old code always read Rachel/blank.
      var voiceLabel = safeFileStr((vgVoiceName(voiceId) || 'voice').split(' ')[0]) || 'voice';
      var userSuffix = safeFileStr(userFilename);
      var customName = voiceLabel + (userSuffix ? '_' + userSuffix : '') + '_' + genTimestamp();
      endpoint = '/tts/generate';
      body = {
        apiKey: ELEVENLABS_KEY, voiceId: voiceId, modelId: els.modelSelect.value,
        text: text, filename: customName, variations: numVar,
        outputFormat: outputFmt,
        languageCode: getLangCode(),
        settings: getTtsSettings(),
        outputDir: '', // temp only; move to chosen folder happens on Import
      };
      label = 'voice';
    } else if (currentMode === 'sfx') {
      var sfxText = safeVal($('vgSfxText'));
      if (!sfxText) return setStatus('Sound description is empty', false);
      var userSuffix = safeFileStr(userFilename);
      var customName = 'sfx' + (userSuffix ? '_' + userSuffix : '') + '_' + genTimestamp();
      endpoint = '/sfx/generate';
      body = {
        apiKey: ELEVENLABS_KEY, text: sfxText,
        durationSec: parseFloat($('vgSfxDuration').value),
        promptInfluence: parseFloat($('vgSfxInfluence').value),
        filename: customName, variations: numVar,
        outputFormat: ($('vgSfxOutputFormat') && $('vgSfxOutputFormat').value) || 'mp3_44100_128',
        outputDir: '', // temp only; move to chosen folder happens on Import
      };
      label = 'SFX';
    } else if (currentMode === 'music') {
      var prompt = safeVal($('vgMusicPrompt'));
      if (!prompt) return setStatus('Music prompt is empty', false);
      var userSuffix = safeFileStr(userFilename);
      var customName = 'music' + (userSuffix ? '_' + userSuffix : '') + '_' + genTimestamp();
      endpoint = '/music/generate';
      body = {
        apiKey: ELEVENLABS_KEY, prompt: prompt,
        lengthSec: parseFloat($('vgMusicLength').value),
        filename: customName, variations: numVar,
        outputDir: '', // temp only; move to chosen folder happens on Import
      };
      label = 'music';
    }

    els.btnGenerate.disabled = true;
    piSetBtn(els.btnGenerate, 'rotate_right', 'Generating ' + numVar + ' ' + label + '...', '#ffffff', 14);
    setStatus('Calling ElevenLabs...', false);

    try {
      var resp = await postJsonVG(endpoint, body);
      if (!resp.ok) throw new Error(resp.error || 'generation failed');
      lastVariations = resp.variations || [];
      renderVariations();
      els.resultSection.hidden = false;
      els.importStatus.textContent = '';
      els.importStatus.className = 'ac-manualStatus';
      setStatus('✓ Generated ' + lastVariations.length + ' ' + label + ' · click play to preview', true);
    } catch(e) {
      setStatus('✗ ' + e.message, false);
    } finally {
      els.btnGenerate.disabled = false;
      piSetBtn(els.btnGenerate, 'bolt', 'GENERATE VOICE', '#ffffff', 14);
    }
  }

  // Mode switcher
  function switchMode(mode) {
    currentMode = mode;
    document.querySelectorAll('.vg-modeBtn').forEach(function(btn) {
      btn.classList.toggle('is-active', btn.dataset.mode === mode);
    });
    document.querySelectorAll('.vg-modeContent').forEach(function(c) {
      c.hidden = c.dataset.mode !== mode;
    });
    var isCreate = (mode === 'create');
    var genBar = document.querySelector('.vg-genBar');
    var vgRight = document.querySelector('.vg-right');
    if (genBar)  genBar.style.display  = isCreate ? 'none' : '';
    if (vgRight) vgRight.style.display = isCreate ? 'none' : '';
    if (els.resultSection) els.resultSection.hidden = true;
    var genLabels = {
      tts:   { ic: 'bolt',        label: 'GENERATE VOICE' },
      sfx:   { ic: 'wave_square', label: 'GENERATE SFX' },
      music: { ic: 'audio',       label: 'GENERATE MUSIC' },
    };
    var gl = genLabels[mode] || genLabels.tts;
    piSetBtn(els.btnGenerate, gl.ic, gl.label, '#ffffff', 14);
  }

  function renderVariations() {
    // Show single-speaker container, hide+clear multi-speaker container
    var singleVars = document.getElementById('vgSingleVars');
    var multiVars  = document.getElementById('vgMultiVars');
    if (singleVars) singleVars.style.display = '';
    if (multiVars)  { multiVars.style.display = 'none'; multiVars.innerHTML = ''; }

    var v1 = lastVariations[0];
    var v2 = lastVariations[1];
    if (v1) {
      els.var1.style.display = '';
      players.var1.setSrc(v1.audioPath);
      els.var1Size.textContent = (v1.sizeBytes / 1024).toFixed(0) + ' KB · ' + v1.filename;
    } else {
      els.var1.style.display = 'none';
    }
    if (v2) {
      els.var2.style.display = '';
      players.var2.setSrc(v2.audioPath);
      els.var2Size.textContent = (v2.sizeBytes / 1024).toFixed(0) + ' KB · ' + v2.filename;
    } else {
      els.var2.style.display = 'none';
    }
  }

  function renderMultiResults(cards) {
    if (!els.resultSection) return;
    // Use dedicated multi-speaker container — never touch vgSingleVars (preserves els.var1/var2)
    var singleVars = document.getElementById('vgSingleVars');
    var multiVars  = document.getElementById('vgMultiVars');
    if (!multiVars) return;
    if (singleVars) singleVars.style.display = 'none';
    multiVars.innerHTML = '';
    multiVars.style.display = '';
    els.resultSection.hidden = false;
    cards.forEach(function(card) {
      var header = document.createElement('div');
      header.className = 'vg-multiSpeakerHeader';
      header.textContent = card.speaker.voiceName;
      header.style.borderLeftColor = card.speaker.color;
      multiVars.appendChild(header);

      card.variations.forEach(function(v, idx) {
        var wrap = document.createElement('div');
        wrap.className = 'vg-variation';
        var sizeTxt = (v.sizeBytes / 1024).toFixed(0) + ' KB · ' + v.filename;

        var cardPath = v.audioPath;
        var cardPlaying = false;

        var playB = document.createElement('div');
        playB.className = 'vg-playBtn';
        playB.setAttribute('role', 'button');
        piMakeButton(playB);
        piSetBtn(playB, 'play');

        var progWrap = document.createElement('div');
        progWrap.className = 'vg-progressWrap';
        var fill = document.createElement('div');
        fill.className = 'vg-progressFill';
        progWrap.appendChild(fill);

        var timeEl = document.createElement('span');
        timeEl.className = 'vg-time';
        timeEl.textContent = '0:00 / ?';

        var cardDuration = 0;
        var cardStartedAt = 0;
        var cardStartOffset = 0;
        var cardTicker = null;

        function fmtTime(s) {
          if (!isFinite(s) || s < 0) s = 0;
          var m = Math.floor(s / 60), sec = Math.floor(s % 60);
          return m + ':' + (sec < 10 ? '0' : '') + sec;
        }
        function stopCardTicker() {
          if (cardTicker) { clearInterval(cardTicker); cardTicker = null; }
        }
        function updateCardTick() {
          var elapsed = cardStartOffset + (Date.now() - cardStartedAt) / 1000;
          if (cardDuration > 0 && elapsed > cardDuration) elapsed = cardDuration;
          timeEl.textContent = fmtTime(elapsed) + ' / ' + fmtTime(cardDuration);
          fill.style.width = cardDuration > 0 ? (elapsed / cardDuration * 100).toFixed(1) + '%' : '0%';
        }
        function setCardPlaying(val) {
          cardPlaying = val;
          piSetBtn(playB, val ? 'pause' : 'play');
          if (!val) stopCardTicker();
        }
        function doCardPlay(offset) {
          offset = offset || 0;
          cardStartOffset = offset;
          cardStartedAt   = Date.now();
          setCardPlaying(true);
          cardTicker = setInterval(updateCardTick, 200);
          vgPlayPath(cardPath, null,
            function() {
              setCardPlaying(false);
              fill.style.width = cardDuration > 0 ? '100%' : '0%';
              timeEl.textContent = fmtTime(cardDuration) + ' / ' + fmtTime(cardDuration);
            },
            function(e) { setCardPlaying(false); console.warn('[VG multi player]', e); },
            offset
          );
        }
        playB.addEventListener('click', function() {
          if (cardPlaying) { vgStopAll(); return; }
          doCardPlay(0);
        });

        // Fetch duration for this card
        fetch(BRIDGE_URL + '/tts/duration', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioPath: cardPath }),
        }).then(function(r) { return r.json(); }).then(function(d) {
          if (d.ok && d.duration > 0) {
            cardDuration = d.duration;
            timeEl.textContent = '0:00 / ' + fmtTime(cardDuration);
          }
        }).catch(function() {});

        progWrap.addEventListener('click', function(e) {
          if (cardDuration <= 0) return;
          var rect = progWrap.getBoundingClientRect();
          var frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          var offset = frac * cardDuration;
          if (cardPlaying) { vgStopAll(); stopCardTicker(); setCardPlaying(false); }
          setTimeout(function() { doCardPlay(offset); }, 60);
        });

        var playerRow = document.createElement('div');
        playerRow.className = 'vg-player';
        playerRow.appendChild(playB);
        playerRow.appendChild(progWrap);
        playerRow.appendChild(timeEl);

        var sizeEl = document.createElement('div');
        sizeEl.className = 'vg-varSize';
        sizeEl.textContent = (idx === 0 ? 'Var 1: ' : 'Var 2: ') + sizeTxt;

        var importB = document.createElement('div');
        importB.className = 'ac-secondaryButton vg-actionButton';
        importB.setAttribute('role', 'button');
        importB.textContent = 'Import';
        importB.addEventListener('click', function() { importVariation(v); });

        // Import + drop on the timeline at the playhead (first free audio track)
        var toTimelineB = document.createElement('div');
        toTimelineB.className = 'ac-secondaryButton vg-actionButton';
        toTimelineB.setAttribute('role', 'button');
        piSetBtn(toTimelineB, 'download', 'Timeline', null, 12);
        toTimelineB.addEventListener('click', function() { importToTimeline(v); });

        // Move to Autocut — feed this generated voice into the Autocut pipeline
        var toAutocutB = document.createElement('div');
        toAutocutB.className = 'ac-secondaryButton vg-actionButton';
        toAutocutB.setAttribute('role', 'button');
        piSetBtn(toAutocutB, 'arrow_right', 'Autocut', null, 12);
        toAutocutB.addEventListener('click', function() { moveToAutocut(v); });

        var actionsRow = document.createElement('div');
        actionsRow.className = 'vg-resultActions';
        actionsRow.appendChild(importB);
        actionsRow.appendChild(toTimelineB);
        actionsRow.appendChild(toAutocutB);

        wrap.appendChild(sizeEl);
        wrap.appendChild(playerRow);
        wrap.appendChild(actionsRow);
        multiVars.appendChild(wrap);
      });
    });

    var statusEl = document.createElement('div');
    statusEl.className = 'ac-manualStatus';
    multiVars.appendChild(statusEl);
    els.importStatus = statusEl;
  }

  async function importVariation(variation) {
    if (!variation) return;
    els.importStatus.className = 'ac-manualStatus';

    // Ask for filename + folder via a custom modal. UXP's native getFileForSaving
    // cannot pre-set its initial folder, so we use our own modal that remembers the
    // last-used folder: from the 2nd import on, the folder is already filled in and
    // you only type the name. promptSaveLocation persists the folder.
    var picked = await promptSaveLocation(variation.filename || 'voice.mp3');
    if (!picked) {
      els.importStatus.className = 'ac-manualStatus is-err';
      els.importStatus.textContent = '✗ Cancelled';
      return;
    }
    var saveDir  = picked.dir;
    var saveName = picked.name;
    if (els.outputFolder) els.outputFolder.value = saveDir;

    var finalPath = variation.audioPath;
    var alreadyInDest = variation.audioPath && variation.audioPath.startsWith(saveDir) &&
                        (!saveName || variation.audioPath.endsWith('/' + saveName));

    if (!alreadyInDest) {
      els.importStatus.textContent = 'Moving file...';
      try {
        var movePayload = { sourcePath: variation.audioPath, targetDir: saveDir };
        if (saveName) movePayload.targetName = saveName;
        var moveResp = await postJsonVG('/tts/move', movePayload);
        if (!moveResp.ok) throw new Error(moveResp.error || 'move failed');
        finalPath = moveResp.targetPath;
      } catch(e) {
        els.importStatus.className = 'ac-manualStatus is-err';
        els.importStatus.textContent = '✗ Move failed: ' + e.message;
        return;
      }
    }

    els.importStatus.textContent = 'Importing ' + variation.filename + ' to Premiere...';
    try {
      if (!ppro || !ppro.Project) throw new Error('Premiere API unavailable');
      var project = await getActiveProject();
      if (typeof project.importFiles === 'function') {
        await project.importFiles([finalPath]);
      } else if (typeof project.importFile === 'function') {
        await project.importFile(finalPath);
      } else {
        throw new Error('No importFiles API on project');
      }
      var importedName = saveName || variation.filename;
      els.importStatus.className = 'ac-manualStatus is-ok';
      els.importStatus.textContent = '✓ Imported "' + importedName + '" → Project Panel';
      // Move to "Voice Over" bin only if checkbox is checked
      if (ppShouldMoveToVOBin()) {
        try {
          var rootItem = null;
          if (typeof project.getRootItem === 'function') {
            rootItem = project.getRootItem();
            if (rootItem && typeof rootItem.then === 'function') rootItem = await rootItem;
          }
          if (rootItem) {
            var fname2 = importedName || finalPath.split('/').pop();
            var binItems2 = await sacCollectBinItems(rootItem);
            var voItem2 = binItems2.find(function(b) { return b.name === fname2; });
            if (voItem2) await ppMoveToVOBin(voItem2.item, project);
          }
        } catch(evb) { console.warn('[ppVO] importVariation moveBin:', evb.message); }
      }
    } catch(e) {
      els.importStatus.className = 'ac-manualStatus is-err';
      els.importStatus.textContent = '✗ Import: ' + e.message;
    }
  }

  // Import the variation AND drop it on the timeline at the playhead, on the
  // first audio track that is free there (never overwrites existing audio).
  async function importToTimeline(variation) {
    if (!variation || !variation.audioPath) return;
    if (!els.importStatus) els.importStatus = $('vgImportStatus');
    var setMsg = function(cls, txt) { if (els.importStatus) { els.importStatus.className = 'ac-manualStatus' + (cls ? ' ' + cls : ''); els.importStatus.textContent = txt; } };
    try {
      if (!ppro || !ppro.SequenceEditor) throw new Error('Premiere 25.x API (SequenceEditor) không khả dụng');
      // 1. Ask where to save (same modal as Import) — temp files get cleaned, so the
      //    clip needs a permanent path before it goes on the timeline.
      var picked = await promptSaveLocation(variation.filename || 'voice.mp3');
      if (!picked) { setMsg('is-err', '✗ Cancelled'); return; }
      var saveDir = picked.dir, saveName = picked.name;
      if (els.outputFolder) els.outputFolder.value = saveDir;
      var finalPath = variation.audioPath;
      var alreadyInDest = variation.audioPath.startsWith(saveDir) && (!saveName || variation.audioPath.endsWith('/' + saveName));
      if (!alreadyInDest) {
        var mp = { sourcePath: variation.audioPath, targetDir: saveDir };
        if (saveName) mp.targetName = saveName;
        var mr = await postJsonVG('/tts/move', mp);
        if (!mr || !mr.ok) throw new Error((mr && mr.error) || 'move failed');
        finalPath = mr.targetPath;
      }
      var fname = finalPath.split('/').pop();

      // 2. Import (if not already in bin) + locate the ProjectItem.
      setMsg('', 'Đang import + đặt lên timeline...');
      var project = await getActiveProject();
      if (!project) throw new Error('Không có project đang mở');
      var rootItem = (typeof project.getRootItem === 'function') ? project.getRootItem() : project.rootItem;
      if (rootItem && typeof rootItem.then === 'function') rootItem = await rootItem;
      var find = async function() {
        var its = rootItem ? await sacCollectBinItems(rootItem) : [];
        return its.find(function(b) { return b.name === fname; });
      };
      var found = await find();
      if (!found) {
        if (typeof project.importFiles === 'function') await project.importFiles([finalPath]);
        else if (typeof project.importFile === 'function') await project.importFile(finalPath);
        else throw new Error('No importFiles API');
        found = await find();
      }
      if (!found) throw new Error('Không tìm thấy clip trong bin sau khi import');
      var item = found.item;

      // 3. Playhead time + first audio track free at that point.
      var seq = await getActiveSequence();
      if (!seq) throw new Error('Chưa mở sequence');
      var ph = seq.getPlayerPosition ? seq.getPlayerPosition() : null;
      if (ph && ph.then) ph = await ph;
      var atSec = getTimeSec(ph);
      var dur = Number(variation.duration) || 0.05;
      var aCount = seq.getAudioTrackCount ? seq.getAudioTrackCount() : 0;
      if (aCount && aCount.then) aCount = await aCount;
      aCount = aCount || 0;
      var targetA = -1;
      for (var i = 0; i < aCount; i++) {
        var tr = seq.getAudioTrack(i); if (tr && tr.then) tr = await tr;
        var clips = []; try { clips = await getClipItems(tr); } catch (e) {}
        var busy = false;
        for (var k = 0; k < clips.length; k++) {
          var cs = 0, ce = 0;
          try { var gs = clips[k].getStartTime ? clips[k].getStartTime() : clips[k].getStart(); if (gs && gs.then) gs = await gs; cs = getTimeSec(gs); } catch (e) {}
          try { var ge = clips[k].getEndTime ? clips[k].getEndTime() : null; if (ge && ge.then) ge = await ge; ce = getTimeSec(ge); } catch (e) {}
          if (atSec < ce - 0.001 && (atSec + dur) > cs + 0.001) { busy = true; break; }
        }
        if (!busy) { targetA = i; break; }
      }
      if (targetA < 0) targetA = aCount; // all busy → ask Premiere for a new track index

      // 4. Place (overwrite — track is free here, so nothing is clobbered).
      var seqEditor = ppro.SequenceEditor.getEditor(seq);
      var timeAt = ppro.TickTime.createWithSeconds(Math.max(0, atSec));
      var txErr = null;
      var r = project.lockedAccess(function() {
        try { project.executeTransaction(function(ca) { ca.addAction(seqEditor.createOverwriteItemAction(item, timeAt, 5, targetA)); }, 'VG import to timeline'); }
        catch (e) { txErr = e; }
      });
      if (r && typeof r.then === 'function') await r;
      if (txErr) throw txErr;

      try { await ppMoveToVOBinIfEnabled(item, project); } catch (e) {}
      setMsg('is-ok', '✓ Đã đặt "' + fname + '" lên A' + (targetA + 1) + ' tại ' + atSec.toFixed(2) + 's');
    } catch (e) {
      setMsg('is-err', '✗ Timeline: ' + e.message);
    }
  }

  // ── Save-name history & presets ────────────────────────────────────────────
  // localStorage helpers (tolerant of missing / malformed JSON).
  function vgGetNameList(key) {
    try { var a = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function vgSetNameList(key, arr) {
    try { localStorage.setItem(key, JSON.stringify(arr)); } catch (e) {}
  }
  // Build the default suggested name: v{lastVersion} - {currentVoiceName}
  // (no extension — okB appends the ext automatically on save).
  function vgBuildDefaultName() {
    var ver = '';
    try { ver = localStorage.getItem('vg_last_version') || ''; } catch (e) {}
    if (!ver) ver = '1.0';
    var voice = 'Voice';
    try { voice = vgVoiceName() || 'Voice'; } catch (e) {}
    return 'v' + ver + ' - ' + voice;
  }
  // On a successful save: remember the version and push the name into recents (cap 5).
  function vgRememberSavedName(finalName) {
    var m = /^v\s*([0-9]+(?:\.[0-9x]+)?)/i.exec(finalName);
    if (m) { try { localStorage.setItem('vg_last_version', m[1]); } catch (e) {} }
    var r = vgGetNameList('vg_recent_names').filter(function (n) { return n !== finalName; });
    r.unshift(finalName);
    if (r.length > 5) r = r.slice(0, 5);
    vgSetNameList('vg_recent_names', r);
  }
  // On a successful save: push the folder into recent folders (cap 5, newest first).
  function vgRememberSavedFolder(dir) {
    if (!dir) return;
    var r = vgGetNameList('vg_recent_folders').filter(function (d) { return d !== dir; });
    r.unshift(dir);
    if (r.length > 5) r = r.slice(0, 5);
    vgSetNameList('vg_recent_folders', r);
  }

  // Custom save modal: lets the user type a filename while showing (and remembering)
  // the destination folder. Resolves to { dir, name } or null if cancelled.
  // Needed because UXP's native getFileForSaving cannot open at a remembered folder.
  function promptSaveLocation(suggestedName) {
    return new Promise(function(resolve) {
      var modal    = $('vgSaveModal');
      var nameInp  = $('vgSaveName');
      var folderEl = $('vgSaveFolder');
      var changeB  = $('vgSaveChangeFolder');
      var cancelB  = $('vgSaveCancel');
      var okB      = $('vgSaveConfirm');
      var recentBtn   = $('vgSaveRecentBtn');
      var presetBtn   = $('vgSavePresetBtn');
      var presetAddB  = $('vgSavePresetAdd');
      var recentPanel = $('vgSaveRecentPanel');
      var presetPanel = $('vgSavePresetPanel');
      var fRecentBtn   = $('vgSaveFolderRecentBtn');
      var fBmBtn       = $('vgSaveFolderBmBtn');
      var fBmToggle    = $('vgSaveFolderBmToggle');
      var fRecentPanel = $('vgSaveFolderRecentPanel');
      var fBmPanel     = $('vgSaveFolderBmPanel');
      if (!modal || !nameInp || !okB) { resolve(null); return; }

      suggestedName = suggestedName || 'voice.mp3';
      var dot = suggestedName.lastIndexOf('.');
      var ext = dot >= 0 ? suggestedName.substring(dot) : '.mp3';
      // Smart default: v{lastVersion} - {currentVoiceName} (ext added on save).
      nameInp.value = vgBuildDefaultName();

      // Hide the rest of the VoiceGen UI while the modal is open. UXP renders native
      // <input>/<textarea> on top of everything regardless of DOM order, so the
      // background textboxes would otherwise punch through the modal. The modal is a
      // sibling of .vg-app, so hiding .vg-app leaves the modal (and its own input) visible.
      var vgApp = document.querySelector('#tab-voicegen .vg-app');

      function renderFolder() {
        if (customOutputFolder) { folderEl.textContent = customOutputFolder; }
        else { folderEl.innerHTML = '(chưa chọn — bấm <span class="p-ic" style="margin:0 2px;vertical-align:-2px">' + window.pluginIconSVG('folder_open', 11, '#cbd5e1') + '</span> Đổi…)'; }
      }
      renderFolder();

      // ── Recent / preset dropdowns (custom toggle-panels; native <select> is
      //    unreliable in UXP and would punch through the modal). ──────────────
      function closePanels() {
        if (recentPanel) recentPanel.hidden = true;
        if (presetPanel) presetPanel.hidden = true;
        if (fRecentPanel) fRecentPanel.hidden = true;
        if (fBmPanel) fBmPanel.hidden = true;
      }
      function fillName(n) {
        nameInp.value = n;
        closePanels();
        try { nameInp.focus(); if (nameInp.select) nameInp.select(); } catch (e) {}
      }
      function renderRecent() {
        if (!recentPanel) return;
        recentPanel.innerHTML = '';
        var list = vgGetNameList('vg_recent_names');
        if (!list.length) { recentPanel.innerHTML = '<div class="vg-nameRow vg-nameRow--empty">(chưa có tên nào)</div>'; return; }
        list.forEach(function (n) {
          var row = document.createElement('div');
          row.className = 'vg-nameRow';
          row.textContent = n;
          row.onclick = function () { fillName(n); };
          recentPanel.appendChild(row);
        });
      }
      function renderPresets() {
        if (!presetPanel) return;
        presetPanel.innerHTML = '';
        var list = vgGetNameList('vg_name_presets');
        if (!list.length) { presetPanel.innerHTML = '<div class="vg-nameRow vg-nameRow--empty">(chưa có preset)</div>'; return; }
        list.forEach(function (n) {
          var row = document.createElement('div');
          row.className = 'vg-nameRow';
          var label = document.createElement('span');
          label.className = 'vg-nameRowLabel';
          label.textContent = n;
          label.onclick = function () { fillName(n); };
          var del = document.createElement('span');
          del.className = 'vg-nameRowDel';
          del.setAttribute('role', 'button');
          del.innerHTML = window.pluginIconSVG('trash', 12, '#fca5a5');
          del.onclick = function (e) {
            if (e && e.stopPropagation) e.stopPropagation();
            var arr = vgGetNameList('vg_name_presets').filter(function (x) { return x !== n; });
            vgSetNameList('vg_name_presets', arr);
            renderPresets();
          };
          row.appendChild(label); row.appendChild(del);
          presetPanel.appendChild(row);
        });
      }
      if (recentBtn) recentBtn.onclick = function () {
        var show = recentPanel && recentPanel.hidden;
        closePanels();
        if (show) { renderRecent(); recentPanel.hidden = false; }
      };
      if (presetBtn) presetBtn.onclick = function () {
        var show = presetPanel && presetPanel.hidden;
        closePanels();
        if (show) { renderPresets(); presetPanel.hidden = false; }
      };
      if (presetAddB) presetAddB.onclick = function () {
        var name = (nameInp.value || '').trim();
        if (!name) { try { nameInp.focus(); } catch (e) {} return; }
        var arr = vgGetNameList('vg_name_presets');
        if (arr.indexOf(name) === -1) { arr.push(name); vgSetNameList('vg_name_presets', arr); }
        renderPresets();
        closePanels();
        if (presetPanel) presetPanel.hidden = false; // show the updated list
      };

      // ── Folder recent / bookmark dropdowns (same pattern; path strings are
      //    reused directly via the bridge, so no UXP folder token needed). ────
      function isFolderBookmarked() {
        return !!customOutputFolder && vgGetNameList('vg_folder_bookmarks').indexOf(customOutputFolder) !== -1;
      }
      function renderBmToggle() {
        if (!fBmToggle) return;
        var on = isFolderBookmarked();
        fBmToggle.classList.toggle('is-on', on);
        fBmToggle.innerHTML = window.pluginIconSVG('floppy_disk', 13, on ? '#3b82f6' : '#94a3b8');
      }
      function setFolder(dir) {
        if (!dir) return;
        customOutputFolder = dir;
        if (els.outputFolder) els.outputFolder.value = dir;
        try { localStorage.setItem('vg_last_save_folder', dir); } catch (e) {}
        renderFolder();
        renderBmToggle();
        closePanels();
      }
      function renderFolderList(panel, key, emptyMsg, withDelete) {
        if (!panel) return;
        panel.innerHTML = '';
        var list = vgGetNameList(key);
        if (!list.length) { panel.innerHTML = '<div class="vg-nameRow vg-nameRow--empty">' + emptyMsg + '</div>'; return; }
        list.forEach(function (d) {
          var row = document.createElement('div');
          row.className = 'vg-nameRow';
          var label = document.createElement('span');
          label.className = 'vg-nameRowLabel';
          label.textContent = d;
          label.onclick = function () { setFolder(d); };
          row.appendChild(label);
          if (withDelete) {
            var del = document.createElement('span');
            del.className = 'vg-nameRowDel';
            del.setAttribute('role', 'button');
            del.innerHTML = window.pluginIconSVG('trash', 12, '#fca5a5');
            del.onclick = function (e) {
              if (e && e.stopPropagation) e.stopPropagation();
              var arr = vgGetNameList(key).filter(function (x) { return x !== d; });
              vgSetNameList(key, arr);
              renderFolderList(panel, key, emptyMsg, withDelete);
              renderBmToggle(); // active folder may have just been un-bookmarked
            };
            row.appendChild(del);
          }
          panel.appendChild(row);
        });
      }
      if (fRecentBtn) fRecentBtn.onclick = function () {
        var show = fRecentPanel && fRecentPanel.hidden;
        closePanels();
        if (show) { renderFolderList(fRecentPanel, 'vg_recent_folders', '(chưa có thư mục nào)', false); fRecentPanel.hidden = false; }
      };
      if (fBmBtn) fBmBtn.onclick = function () {
        var show = fBmPanel && fBmPanel.hidden;
        closePanels();
        if (show) { renderFolderList(fBmPanel, 'vg_folder_bookmarks', '(chưa có bookmark)', true); fBmPanel.hidden = false; }
      };
      if (fBmToggle) fBmToggle.onclick = function () {
        if (!customOutputFolder) { if (changeB.onclick) changeB.onclick(); return; } // pick one first
        var arr = vgGetNameList('vg_folder_bookmarks');
        var i = arr.indexOf(customOutputFolder);
        if (i === -1) arr.push(customOutputFolder); else arr.splice(i, 1); // toggle save/unsave
        vgSetNameList('vg_folder_bookmarks', arr);
        renderBmToggle();
        if (fBmPanel && !fBmPanel.hidden) renderFolderList(fBmPanel, 'vg_folder_bookmarks', '(chưa có bookmark)', true);
      };
      renderBmToggle();
      closePanels();

      if (vgApp) vgApp.style.display = 'none';
      modal.hidden = false;
      try { nameInp.focus(); if (nameInp.select) nameInp.select(); } catch(e) {}
      if (window.claimKeyboard) window.claimKeyboard();

      function cleanup() {
        modal.hidden = true;
        if (vgApp) vgApp.style.display = '';
        if (window.releaseKeyboard) window.releaseKeyboard();
        closePanels();
        changeB.onclick = null; cancelB.onclick = null; okB.onclick = null;
        nameInp.onkeydown = null;
        if (recentBtn) recentBtn.onclick = null;
        if (presetBtn) presetBtn.onclick = null;
        if (presetAddB) presetAddB.onclick = null;
        if (fRecentBtn) fRecentBtn.onclick = null;
        if (fBmBtn) fBmBtn.onclick = null;
        if (fBmToggle) fBmToggle.onclick = null;
      }
      changeB.onclick = async function() {
        await pickOutputFolder(); // updates + persists customOutputFolder
        renderFolder();
        renderBmToggle();
        try { nameInp.focus(); } catch(e) {}
      };
      cancelB.onclick = function() { cleanup(); resolve(null); };
      okB.onclick = function() {
        var name = (nameInp.value || '').trim();
        if (!name) { try { nameInp.focus(); } catch(e) {} return; }
        if (!customOutputFolder) { changeB.onclick(); return; } // must pick a folder first
        if (ext && name.toLowerCase().slice(-ext.length) !== ext.toLowerCase()) name += ext;
        var dir = customOutputFolder;
        vgRememberSavedName(name);   // persist version + push to recent names
        vgRememberSavedFolder(dir);  // push to recent folders
        cleanup();
        resolve({ dir: dir, name: name });
      };
      nameInp.onkeydown = function(e) {
        if (e.key === 'Enter')      { e.preventDefault(); okB.onclick(); }
        else if (e.key === 'Escape'){ e.preventDefault(); cancelB.onclick(); }
      };
    });
  }

  async function pickOutputFolder() {
    try {
      var uxp = window.require && window.require('uxp');
      if (!uxp || !uxp.storage) {
        alert('UXP storage API not available');
        return;
      }
      var lfs = uxp.storage.localFileSystem;
      var folder = await lfs.getFolder();
      if (!folder) return; // cancelled
      customOutputFolder = folder.nativePath || folder.path || '';
      els.outputFolder.value = customOutputFolder;
      if (customOutputFolder) localStorage.setItem('vg_last_save_folder', customOutputFolder);
      console.log('[VoiceGen] output folder picked:', customOutputFolder);
    } catch(e) {
      alert('Cannot pick folder: ' + e.message);
    }
  }

  function resetOutputFolder() {
    customOutputFolder = '';
    els.outputFolder.value = '';
    localStorage.removeItem('vg_last_save_folder');
  }

  // Wire events
  els.btnRefresh.addEventListener('click', loadVoices);

  // ⚙ Voice Gen settings live in the unified Settings modal (⚙ chính → tab Voice Gen).
  // The status-bar gear was removed to avoid a duplicate entry point.
  els.voiceSelect.addEventListener('change', function() {
    els.customVoiceId.hidden = els.voiceSelect.value !== '__custom__';
    if (!els.customVoiceId.hidden) els.customVoiceId.focus();
    // Keep active speaker's voice in sync
    saveCurrentSpeakerText();
    renderSpeakerBar();
  });
  els.btnGenerate.addEventListener('click', generate);
  if (els.btnBrowseFolder) els.btnBrowseFolder.addEventListener('click', pickOutputFolder);
  if (els.btnResetFolder) els.btnResetFolder.addEventListener('click', resetOutputFolder);

  // ── Organize script (normalize + emotion tags) — Claude or Gemini ──────────
  var vgOrgModel = $('vgOrganizeModel');
  if (vgOrgModel) {
    vgOrgModel.value = sacResolveOrganizeModel(); // Gemini nếu có key, else Sonnet (hoặc pick của user)
    vgOrgModel.addEventListener('change', function() {
      ORGANIZE_MODEL = vgOrgModel.value;
      localStorage.setItem('sac_organize_model', ORGANIZE_MODEL);
      var sa = document.getElementById('sacAiModel'); if (sa) sa.value = ORGANIZE_MODEL; // keep in sync
    });
  }
  var vgOrgBtn = $('vgOrganizeBtn');
  // Cancel-able Organize: token + AbortController (giống luồng normalize của Autocut).
  var vgOrgBusy = false, vgOrgAbort = null, vgOrgToken = 0;
  function vgOrgSetIdle() {
    vgOrgBusy = false; vgOrgAbort = null;
    if (vgOrgBtn) { vgOrgBtn.classList.remove('is-cancel'); piSetBtn(vgOrgBtn, 'wand_magic_sparkles', 'Organize', null, 13); }
  }
  if (vgOrgBtn) vgOrgBtn.addEventListener('click', async function() {
    // Đang chạy → bấm lần nữa = Huỷ.
    if (vgOrgBusy) {
      vgOrgToken++;                                        // vô hiệu kết quả đang chờ
      if (vgOrgAbort) { try { vgOrgAbort.abort(); } catch(e){} }
      vgOrgSetIdle();
      return;
    }
    var ta = els.script;
    if (!ta) return;
    var lines = String(ta.value || '').split('\n').map(function(l){ return l.trim(); }).filter(Boolean);
    if (!lines.length) { vgOrgSetIdle(); return; }
    var cfg = window.sacOrganizeConfig ? window.sacOrganizeConfig() : { provider:'anthropic', model:null, apiKey:'' };
    var myToken = ++vgOrgToken;
    vgOrgBusy = true;
    vgOrgAbort = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    vgOrgBtn.classList.add('is-cancel');
    piSetBtn(vgOrgBtn, 'xmark', 'Huỷ', '#fca5a5', 13);
    try {
      var resp = await fetch(BRIDGE_URL + '/superautocut/normalize-script', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: lines, provider: cfg.provider, model: cfg.model, apiKey: cfg.apiKey, mode: 'paragraph' }),
        signal: vgOrgAbort ? vgOrgAbort.signal : undefined,
      });
      if (myToken !== vgOrgToken) return;                  // đã huỷ/superseded khi đang fetch
      var d = await resp.json();
      if (myToken !== vgOrgToken) return;
      if (d.ok && Array.isArray(d.lines) && d.lines.length) {
        ta.value = d.lines.join('\n');
        if (typeof updateCharCount === 'function') updateCharCount();
        vgAutoResize(ta);
      } else {
        alert('Organize lỗi: ' + (d.error || 'không rõ'));
      }
    } catch(e) {
      if (myToken !== vgOrgToken || (e && e.name === 'AbortError')) return; // huỷ → im lặng
      alert('Organize lỗi: ' + e.message);
    } finally {
      if (myToken === vgOrgToken) vgOrgSetIdle();
    }
  });

  // Variation buttons
  if (els.var1Import) els.var1Import.addEventListener('click', function() { importVariation(lastVariations[0]); });
  if (els.var2Import) els.var2Import.addEventListener('click', function() { importVariation(lastVariations[1]); });
  var vgV1TL = $('vgVar1Timeline'), vgV2TL = $('vgVar2Timeline');
  if (vgV1TL) vgV1TL.addEventListener('click', function() { importToTimeline(lastVariations[0]); });
  if (vgV2TL) vgV2TL.addEventListener('click', function() { importToTimeline(lastVariations[1]); });

  // Move to Autocut — pick save location (folder + filename) then push to Autocut
  async function moveToAutocut(v) {
    if (!v || !v.audioPath) return;

    // Same custom save modal as Import (remembers the folder; just type the name).
    var suggested = v.filename || v.audioPath.split('/').pop() || 'voice.mp3';
    var picked = await promptSaveLocation(suggested);
    if (!picked) return; // cancelled
    var saveDir  = picked.dir;
    var saveName = picked.name;
    if (els.outputFolder) els.outputFolder.value = saveDir;

    var finalPath = v.audioPath;
    var alreadyInDest = v.audioPath.startsWith(saveDir) &&
                        (!saveName || v.audioPath.endsWith('/' + saveName));
    if (!alreadyInDest) {
      try {
        var mp = { sourcePath: v.audioPath, targetDir: saveDir };
        if (saveName) mp.targetName = saveName;
        var mr = await postJsonVG('/tts/move', mp);
        if (mr.ok) finalPath = mr.targetPath;
      } catch(e) { console.warn('[VG→AC] Move error:', e.message); }
    }

    if (typeof window.AutocutPushVoice === 'function') window.AutocutPushVoice(finalPath);
  }
  var vgV1ToAC = $('vgVar1ToAutocut'), vgV2ToAC = $('vgVar2ToAutocut');
  if (vgV1ToAC) vgV1ToAC.addEventListener('click', function() { moveToAutocut(lastVariations[0]); });
  if (vgV2ToAC) vgV2ToAC.addEventListener('click', function() { moveToAutocut(lastVariations[1]); });

  if (els.script) {
    els.script.addEventListener('input', updateCharCount);
    els.script.addEventListener('input', function() { vgAutoResize(els.script); });
    // 'paste' may not fire 'input' in UXP — delay so value is updated before measuring
    els.script.addEventListener('paste', function() { setTimeout(function() { vgAutoResize(els.script); updateCharCount(); }, 0); });
  }

  // Language Override toggle
  var langToggle = $('vgLangOverride');
  if (langToggle) langToggle.addEventListener('change', function() {
    var sel = $('vgLangSelect');
    if (sel) sel.hidden = !langToggle.checked;
  });

  // Add Speaker button
  var addSpeakerBtn = $('vgAddSpeaker');
  if (addSpeakerBtn) addSpeakerBtn.addEventListener('click', addSpeaker);

  // Expose voice list so Claude chat can inject it into prompts
  window.VoiceGenGetVoices = function() {
    return VG_VOICES_DATA.slice(); // return a copy
  };

  // ── Voice Create (Clone + Design) ────────────────────────────────────────
  (function() {
    var vcCloneCard      = document.getElementById('vcCloneCard');
    var vcDesignCard     = document.getElementById('vcDesignCard');
    var vcCloneSection   = document.getElementById('vcCloneSection');
    var vcDesignSection  = document.getElementById('vcDesignSection');
    var vcCloneName      = document.getElementById('vcCloneName');
    var vcCloneDesc      = document.getElementById('vcCloneDesc');
    var vcDenoise        = document.getElementById('vcDenoise');
    var vcCloneSubmit    = document.getElementById('vcCloneSubmit');
    var vcCloneStatus    = document.getElementById('vcCloneStatus');
    var vcFromSeqSection = document.getElementById('vcFromSequenceSection');
    var vcFromFileSection= document.getElementById('vcFromFileSection');
    var vcCloneStep2     = document.getElementById('vcCloneStep2');
    var vcCloneStep3     = document.getElementById('vcCloneStep3');
    var vcCloneBtn       = document.getElementById('vcCloneBtn');
    var vcClipInfo       = document.getElementById('vcClipInfo');
    var vcFileInfo       = document.getElementById('vcFileInfo');
    var vcGetClip        = document.getElementById('vcGetClip');
    var vcBrowseFile     = document.getElementById('vcBrowseFile');

    var vcGender         = document.getElementById('vcGender');
    var vcAge            = document.getElementById('vcAge');
    var vcAccent         = document.getElementById('vcAccent');
    var vcAccentStrength = document.getElementById('vcAccentStrength');
    var vcAccentVal      = document.getElementById('vcAccentVal');
    var vcPreviewText    = document.getElementById('vcPreviewText');
    var vcDesignPreview  = document.getElementById('vcDesignPreview');
    var vcPreviewPlayer  = document.getElementById('vcPreviewPlayer');
    var vcPreviewPlay    = document.getElementById('vcPreviewPlay');
    var vcPreviewProgWrap= document.getElementById('vcPreviewProgWrap');
    var vcPreviewFill    = document.getElementById('vcPreviewFill');
    var vcPreviewTime    = document.getElementById('vcPreviewTime');
    var vcDesignSaveSec  = document.getElementById('vcDesignSaveSection');
    var vcDesignName     = document.getElementById('vcDesignName');
    var vcDesignDesc     = document.getElementById('vcDesignDesc');
    var vcDesignSave     = document.getElementById('vcDesignSave');
    var vcDesignStatus   = document.getElementById('vcDesignStatus');

    var vcSelectedFilePath = ''; // for clone: current audio file path
    var vcGenerationId     = ''; // for design: generationId from preview
    var vcPreviewAudioUrl  = ''; // for design preview player
    var vcPreviewIsPlaying = false;
    var vcPreviewDuration  = 0;
    var vcPreviewPosition  = 0;
    var vcPreviewTimer     = null;

    // ── Method picker — two choice cards (Clone / Design) ──
    function vcSelectMethod(m) {
      if (vcCloneCard)    vcCloneCard.classList.toggle('is-active', m === 'clone');
      if (vcDesignCard)   vcDesignCard.classList.toggle('is-active', m === 'design');
      if (vcCloneSection)  vcCloneSection.hidden  = (m !== 'clone');
      if (vcDesignSection) vcDesignSection.hidden = (m !== 'design');
    }
    if (vcCloneCard)  vcCloneCard.addEventListener('click',  function() { vcSelectMethod('clone'); });
    if (vcDesignCard) vcDesignCard.addEventListener('click', function() { vcSelectMethod('design'); });

    // ── Clone step machine ──────────────────────────────────────────────────
    // Step 2 (Clone button) appears once an audio sample exists; Step 3 (name +
    // description) appears only after the user clicks "Clone this voice". Changing
    // source or re-extracting clears the sample and collapses Steps 2 & 3.
    function vcRefreshCloneSteps() {
      var hasAudio = !!vcSelectedFilePath;
      if (vcCloneStep2) vcCloneStep2.hidden = !hasAudio;
      if (!hasAudio && vcCloneStep3) vcCloneStep3.hidden = true; // sample gone → re-collapse details
    }
    if (vcCloneBtn) vcCloneBtn.addEventListener('click', function() {
      if (vcCloneStep3) vcCloneStep3.hidden = false;
      if (vcCloneName) { try { vcCloneName.focus(); } catch(e) {} }
    });

    // ── Audio source radio toggle ──
    document.querySelectorAll('input[name="vcSource"]').forEach(function(radio) {
      radio.addEventListener('change', function() {
        var fromSeq = (radio.value === 'sequence' && radio.checked);
        if (vcFromSeqSection)  vcFromSeqSection.hidden  = !fromSeq;
        if (vcFromFileSection) vcFromFileSection.hidden = fromSeq;
        vcSelectedFilePath = '';
        if (vcClipInfo) vcClipInfo.textContent = 'Grabs every clip on audio track A1 and joins them into one voice sample.';
        if (vcFileInfo) vcFileInfo.textContent = 'Pick an MP3/WAV/M4A file of the voice to clone.';
        vcRefreshCloneSteps(); // switching source collapses Steps 2 & 3
      });
    });

    // ── Get from Sequence ──
    // Reads all clips from audio track A1, extracts each segment via ffmpeg,
    // concatenates them into a single MP3, and sets vcSelectedFilePath to result.
    if (vcGetClip) {
      vcGetClip.addEventListener('click', async function() {
        if (vcClipInfo) vcClipInfo.textContent = 'Reading A1 clips…';
        vcGetClip.disabled = true;
        vcSelectedFilePath = '';
        vcRefreshCloneSteps(); // collapse Steps 2 & 3 while re-extracting
        try {
          if (!ppro) throw new Error('Premiere Pro API not available');
          var seq = await getActiveSequence();
          var track = null;

          // Path A: trackGroup API
          try {
            if (typeof seq.trackGroup === 'function' && ppro.Backend && ppro.Backend.MEDIATYPE_AUDIO !== undefined) {
              var aGroup = seq.trackGroup(ppro.Backend.MEDIATYPE_AUDIO);
              if (aGroup && aGroup.numTracks > 0) track = aGroup.getTrack(0);
            }
          } catch(eA) {}

          // Path B: getAudioTrack
          if (!track) {
            try {
              var cnt = seq.getAudioTrackCount && seq.getAudioTrackCount();
              if (cnt && typeof cnt.then === 'function') cnt = await cnt;
              if (cnt > 0) {
                track = seq.getAudioTrack && seq.getAudioTrack(0);
                if (track && typeof track.then === 'function') track = await track;
              }
            } catch(eB) {}
          }

          if (!track) throw new Error('Cannot access audio track A1');

          var items = await getClipItems(track);
          if (!items.length) throw new Error('No clips on audio track A1');

          if (vcClipInfo) vcClipInfo.textContent = 'Found ' + items.length + ' clip(s), reading paths…';

          var clipList = [];
          for (var i = 0; i < items.length; i++) {
            var ti = items[i];

            // Source in/out points (position in source media file)
            var inSec = 0, outSec = 0;
            try {
              var ip = ti.getInPoint && ti.getInPoint();
              if (ip && typeof ip.then === 'function') ip = await ip;
              if (ip) inSec = getTimeSec(ip);
            } catch(e) {}
            try {
              var op = ti.getOutPoint && ti.getOutPoint();
              if (op && typeof op.then === 'function') op = await op;
              if (op) outSec = getTimeSec(op);
            } catch(e) {}

            // Fallback when in/out unavailable: use clip duration from timeline
            // (only correct if clip's head is not trimmed, inPoint=0)
            if (!outSec || outSec <= inSec) {
              try {
                var gs = ti.getStart && ti.getStart();
                if (gs && typeof gs.then === 'function') gs = await gs;
                var ge = ti.getEnd && ti.getEnd();
                if (ge && typeof ge.then === 'function') ge = await ge;
                inSec = 0; outSec = getTimeSec(ge) - getTimeSec(gs);
              } catch(e) {}
            }

            var fp = await vcGetTrackItemFilePath(ti);
            if (!fp) throw new Error('Clip ' + (i + 1) + ': cannot get source file path — try "From File" instead');

            clipList.push({ filePath: fp, inPoint: inSec, outPoint: outSec });
          }

          if (vcClipInfo) vcClipInfo.textContent = 'Concatenating ' + clipList.length + ' clip(s) via ffmpeg…';

          var resp = await postJsonVG('/tts/concat-from-sequence', {
            clips:     clipList,
            outputDir: '', // temp only; move to chosen folder happens on Import
          });
          if (!resp.ok) throw new Error(resp.error || 'Concat failed');

          vcSelectedFilePath = resp.audioPath;
          var shortName = resp.audioPath.split('/').pop();
          var nClips = clipList.length;
          if (vcClipInfo) {
            vcClipInfo.textContent = '✓ ' + shortName + ' (' + nClips + ' clip' + (nClips > 1 ? 's' : '') + ')';
            vcClipInfo.title = resp.audioPath;
          }
          console.log('[vcGetClip] concat result:', resp.audioPath);
        } catch(e) {
          vcSelectedFilePath = '';
          if (vcClipInfo) vcClipInfo.textContent = '✗ ' + e.message;
          console.error('[vcGetClip]', e);
        } finally {
          vcGetClip.disabled = false;
          vcRefreshCloneSteps(); // reveal Step 2 (Clone button) when a sample is ready
        }
      });
    }

    // ── Browse File ──
    if (vcBrowseFile) {
      vcBrowseFile.addEventListener('click', async function() {
        try {
          var uxp = window.require && window.require('uxp');
          if (!uxp || !uxp.storage) throw new Error('UXP storage not available');
          var file = await uxp.storage.localFileSystem.getFileForOpening({
            types: ['mp3','wav','m4a','aac','ogg','flac'],
          });
          if (!file) return; // cancelled — keep whatever state we had
          var fp = file.nativePath || file.path || '';
          vcSelectedFilePath = fp;
          var shortName = fp.split('/').pop();
          if (vcFileInfo) vcFileInfo.textContent = '✓ ' + shortName;
          if (vcFileInfo) vcFileInfo.title = fp;
          vcRefreshCloneSteps(); // reveal Step 2 (Clone button)
        } catch(e) {
          vcSelectedFilePath = '';
          if (vcFileInfo) vcFileInfo.textContent = '✗ ' + e.message;
          vcRefreshCloneSteps();
        }
      });
    }

    // ── Clone submit ──
    if (vcCloneSubmit) {
      vcCloneSubmit.addEventListener('click', async function() {
        var name = vcCloneName ? vcCloneName.value.trim() : '';
        if (!name)               return showVcStatus(vcCloneStatus, 'Voice name is required', false);
        if (!vcSelectedFilePath) return showVcStatus(vcCloneStatus, 'Select an audio file first', false);
        if (!ELEVENLABS_KEY)     return showVcStatus(vcCloneStatus, 'No ElevenLabs API key set', false);

        vcCloneSubmit.disabled = true;
        piSetBtn(vcCloneSubmit, 'rotate_right', 'Cloning…', '#ffffff', 14);
        showVcStatus(vcCloneStatus, 'Uploading audio to ElevenLabs…', null);
        try {
          var resp = await postJsonVG('/voice/clone', {
            apiKey:      ELEVENLABS_KEY,
            voiceName:   name,
            filePath:    vcSelectedFilePath,
            description: vcCloneDesc ? vcCloneDesc.value.trim() : '',
            removeNoise: vcDenoise  ? vcDenoise.checked : false,
          });
          if (!resp.ok) throw new Error(resp.error || 'clone failed');
          showVcStatus(vcCloneStatus, '✓ Voice cloned! ID: ' + resp.voice_id + '\nReloading voice list…', true);
          // Reload voice list so new voice appears in dropdown
          setTimeout(function() { loadVoices(); }, 1500);
        } catch(e) {
          showVcStatus(vcCloneStatus, '✗ ' + e.message, false);
        } finally {
          vcCloneSubmit.disabled = false;
          piSetBtn(vcCloneSubmit, 'check', 'CREATE VOICE', '#ffffff', 14);
        }
      });
    }

    // ── Accent strength slider ──
    if (vcAccentStrength && vcAccentVal) {
      vcAccentStrength.addEventListener('input', function() {
        vcAccentVal.textContent = Number(vcAccentStrength.value).toFixed(1);
      });
    }

    // ── Design preview ──
    if (vcDesignPreview) {
      vcDesignPreview.addEventListener('click', async function() {
        var text = vcPreviewText ? vcPreviewText.value.trim() : '';
        if (!text)           return showVcStatus(vcDesignStatus, 'Enter preview text first', false);
        if (!ELEVENLABS_KEY) return showVcStatus(vcDesignStatus, 'No ElevenLabs API key set', false);

        vcDesignPreview.disabled = true;
        piSetBtn(vcDesignPreview, 'rotate_right', 'Generating…', '#ffffff', 13);
        showVcStatus(vcDesignStatus, 'Generating voice preview…', null);
        if (vcPreviewPlayer) vcPreviewPlayer.hidden = true;
        if (vcDesignSaveSec) vcDesignSaveSec.hidden = true;
        vcGenerationId = '';

        try {
          var resp = await postJsonVG('/voice/design/preview', {
            apiKey:          ELEVENLABS_KEY,
            gender:          vcGender          ? vcGender.value          : 'female',
            age:             vcAge             ? vcAge.value             : 'young',
            accent:          vcAccent          ? vcAccent.value          : 'american',
            accentStrength:  vcAccentStrength  ? Number(vcAccentStrength.value) : 1.0,
            text:            text,
          });
          if (!resp.ok) throw new Error(resp.error || 'preview failed');
          vcGenerationId    = resp.generationId || '';
          vcPreviewAudioUrl = BRIDGE_URL + resp.previewUrl;
          showVcStatus(vcDesignStatus, '✓ Preview ready. Listen then save if you like it.', true);

          // Show player
          vcPreviewDuration = 0; vcPreviewPosition = 0;
          if (vcPreviewPlayer) vcPreviewPlayer.hidden = false;
          if (vcPreviewFill)   vcPreviewFill.style.width = '0%';
          if (vcPreviewTime)   vcPreviewTime.textContent = '0:00 / 0:00';
          if (vcPreviewPlay)   piSetBtn(vcPreviewPlay, 'play');
          vcPreviewIsPlaying = false;

          // Show save section
          if (vcDesignSaveSec) vcDesignSaveSec.hidden = false;
        } catch(e) {
          showVcStatus(vcDesignStatus, '✗ ' + e.message, false);
        } finally {
          vcDesignPreview.disabled = false;
          piSetBtn(vcDesignPreview, 'play', 'PREVIEW VOICE', '#ffffff', 13);
        }
      });
    }

    // ── Design preview player ──
    if (vcPreviewPlay) {
      vcPreviewPlay.addEventListener('click', function() {
        if (!vcPreviewAudioUrl) return;
        if (vcPreviewIsPlaying) {
          // Stop
          stopVcPreview();
        } else {
          startVcPreview();
        }
      });
    }

    function fmtTime(sec) {
      if (!isFinite(sec)) return '0:00';
      var m = Math.floor(sec / 60);
      var s = Math.floor(sec % 60);
      return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function stopVcPreview() {
      if (vcPreviewTimer) { clearInterval(vcPreviewTimer); vcPreviewTimer = null; }
      // Ask bridge to stop afplay
      postJsonVG('/tts/stop', {}).catch(function(){});
      vcPreviewIsPlaying = false;
      if (vcPreviewPlay) piSetBtn(vcPreviewPlay, 'play');
    }

    function startVcPreview() {
      stopVcPreview();
      vcPreviewIsPlaying = true;
      if (vcPreviewPlay) piSetBtn(vcPreviewPlay, 'stop');
      vcPreviewPosition = 0;
      var startTime = Date.now();
      // Kick off play on bridge
      postJsonVG('/tts/play', { audioUrl: vcPreviewAudioUrl.replace(BRIDGE_URL, '') })
        .then(function() {
          stopVcPreview();
        })
        .catch(function() {
          stopVcPreview();
        });
      // Tick progress
      vcPreviewTimer = setInterval(function() {
        if (!vcPreviewIsPlaying) { clearInterval(vcPreviewTimer); vcPreviewTimer = null; return; }
        vcPreviewPosition = (Date.now() - startTime) / 1000;
        if (vcPreviewDuration > 0) {
          var pct = Math.min((vcPreviewPosition / vcPreviewDuration) * 100, 100);
          if (vcPreviewFill) vcPreviewFill.style.width = pct + '%';
        }
        if (vcPreviewTime) vcPreviewTime.textContent = fmtTime(vcPreviewPosition) + ' / ' + fmtTime(vcPreviewDuration || 0);
      }, 250);
    }

    // ── Design save ──
    if (vcDesignSave) {
      vcDesignSave.addEventListener('click', async function() {
        var name = vcDesignName ? vcDesignName.value.trim() : '';
        if (!name)           return showVcStatus(vcDesignStatus, 'Enter a voice name to save', false);
        if (!vcGenerationId) return showVcStatus(vcDesignStatus, 'Generate a preview first', false);
        if (!ELEVENLABS_KEY) return showVcStatus(vcDesignStatus, 'No ElevenLabs API key set', false);

        vcDesignSave.disabled = true;
        piSetBtn(vcDesignSave, 'rotate_right', 'Saving…', '#ffffff', 13);
        showVcStatus(vcDesignStatus, 'Saving voice to your library…', null);
        try {
          var resp = await postJsonVG('/voice/design/save', {
            apiKey:           ELEVENLABS_KEY,
            voiceName:        name,
            description:      vcDesignDesc ? vcDesignDesc.value.trim() : '',
            generatedVoiceId: vcGenerationId,
          });
          if (!resp.ok) throw new Error(resp.error || 'save failed');
          showVcStatus(vcDesignStatus, '✓ Voice saved! Reloading voice list…', true);
          vcGenerationId = '';
          if (vcDesignSaveSec) vcDesignSaveSec.hidden = true;
          setTimeout(function() { loadVoices(); }, 1500);
        } catch(e) {
          showVcStatus(vcDesignStatus, '✗ ' + e.message, false);
        } finally {
          vcDesignSave.disabled = false;
          piSetBtn(vcDesignSave, 'check', 'SAVE VOICE', '#ffffff', 13);
        }
      });
    }

    function showVcStatus(el, msg, isOk) {
      if (!el) return;
      el.hidden = false;
      el.className = 'vc-status' + (isOk === true ? ' is-ok' : isOk === false ? ' is-error' : '');
      el.textContent = msg;
    }
  })();

  // ── ElevenLabs API Key Profiles ──────────────────────────────────────────
  var vgProfileSelect    = $('vgProfileSelect');
  var vgProfileName      = $('vgProfileName');
  var vgElKeyInput       = $('vgElKeyInput');
  var vgElStatus         = $('vgElStatus');
  var vgSaveKeyBtn       = $('vgSaveKey');
  var vgAddProfileBtn    = $('vgAddProfile');
  var vgDeleteProfileBtn = $('vgDeleteProfile');

  function vgPersistProfiles() {
    var stored = {};
    try { stored = JSON.parse(localStorage.getItem('claude-plugin-settings') || '{}'); } catch(e) {}
    stored.elevenlabsProfiles        = EL_PROFILES;
    stored.elevenlabsActiveProfileId = EL_ACTIVE_PROFILE_ID;
    stored.elevenlabsKey             = ELEVENLABS_KEY;
    localStorage.setItem('claude-plugin-settings', JSON.stringify(stored));
    persistSettingsToFile(stored);
  }

  function updateVgElStatus() {
    if (!vgElStatus) return;
    if (ELEVENLABS_KEY && ELEVENLABS_KEY.length > 8) {
      var k = ELEVENLABS_KEY;
      vgElStatus.textContent = k.slice(0, 5) + '…' + k.slice(-4);
      vgElStatus.classList.add('is-api');
    } else {
      vgElStatus.textContent = 'not set';
      vgElStatus.classList.remove('is-api');
    }
  }

  function vgLoadProfileFields() {
    var active = EL_PROFILES.find(function(p) { return p.id === EL_ACTIVE_PROFILE_ID; });
    if (vgProfileName) vgProfileName.value = active ? active.name : '';
    if (vgElKeyInput)  vgElKeyInput.value  = active ? active.key  : '';
    updateVgElStatus();
  }

  function vgRenderProfiles() {
    if (!vgProfileSelect) return;
    vgProfileSelect.innerHTML = '';
    if (!EL_PROFILES.length) {
      var emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = '— no profiles —';
      vgProfileSelect.appendChild(emptyOpt);
    } else {
      EL_PROFILES.forEach(function(p) {
        var opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name + (p.key ? '' : ' (no key)');
        if (p.id === EL_ACTIVE_PROFILE_ID) opt.selected = true;
        vgProfileSelect.appendChild(opt);
      });
    }
    vgLoadProfileFields();
  }

  // Switch active profile when dropdown changes
  if (vgProfileSelect) {
    vgProfileSelect.addEventListener('change', function() {
      var selId = vgProfileSelect.value;
      if (!selId) return;
      EL_ACTIVE_PROFILE_ID = selId;
      var p = EL_PROFILES.find(function(p) { return p.id === selId; });
      if (p) {
        ELEVENLABS_KEY = p.key;
        voicesLoaded = false;
        vgPersistProfiles();
        vgLoadProfileFields();
        if (ELEVENLABS_KEY) loadVoices();
        else setStatus('Add an API key to this profile', false);
      }
    });
  }

  // Add new blank profile
  if (vgAddProfileBtn) {
    vgAddProfileBtn.addEventListener('click', function() {
      var newId = 'p_' + Date.now();
      EL_PROFILES.push({ id: newId, name: 'New Profile', key: '' });
      EL_ACTIVE_PROFILE_ID = newId;
      vgRenderProfiles();
      if (vgProfileName) {
        try { vgProfileName.focus(); vgProfileName.select(); } catch(e) {}
      }
    });
  }

  // Save (create or update) active profile
  if (vgSaveKeyBtn) {
    vgSaveKeyBtn.addEventListener('click', function() {
      var name = (vgProfileName ? (vgProfileName.value || '') : '').trim() || 'Profile';
      var key  = (vgElKeyInput  ? (vgElKeyInput.value  || '') : '').trim();
      if (!EL_ACTIVE_PROFILE_ID || !EL_PROFILES.find(function(p) { return p.id === EL_ACTIVE_PROFILE_ID; })) {
        var newId = 'p_' + Date.now();
        EL_PROFILES.push({ id: newId, name: name, key: key });
        EL_ACTIVE_PROFILE_ID = newId;
      } else {
        var idx = EL_PROFILES.findIndex(function(p) { return p.id === EL_ACTIVE_PROFILE_ID; });
        if (idx >= 0) { EL_PROFILES[idx].name = name; EL_PROFILES[idx].key = key; }
      }
      ELEVENLABS_KEY = key;
      vgPersistProfiles();
      vgRenderProfiles();
      if (key) {
        voicesLoaded = false;
        loadVoices();
      } else {
        setStatus('ElevenLabs API key required', false);
      }
    });
  }

  // Delete active profile
  if (vgDeleteProfileBtn) {
    vgDeleteProfileBtn.addEventListener('click', function() {
      if (!EL_ACTIVE_PROFILE_ID) return;
      EL_PROFILES = EL_PROFILES.filter(function(p) { return p.id !== EL_ACTIVE_PROFILE_ID; });
      EL_ACTIVE_PROFILE_ID = EL_PROFILES.length ? EL_PROFILES[0].id : null;
      ELEVENLABS_KEY = '';
      if (EL_ACTIVE_PROFILE_ID) {
        var ap = EL_PROFILES.find(function(p) { return p.id === EL_ACTIVE_PROFILE_ID; });
        if (ap) ELEVENLABS_KEY = ap.key;
      }
      vgPersistProfiles();
      vgRenderProfiles();
      voicesLoaded = false;
      if (ELEVENLABS_KEY) loadVoices();
      else setStatus('Set ElevenLabs API key in a profile', false);
    });
  }

  vgRenderProfiles();

  // Auto-refresh when key changes (called from Settings save handler)
  window.VoiceGenOnKeyChange = function() {
    console.log('[VoiceGen] key changed, ELEVENLABS_KEY len=' + (ELEVENLABS_KEY || '').length);
    voicesLoaded = false;
    vgRenderProfiles();
    if (ELEVENLABS_KEY) loadVoices();
    else setStatus('Set ElevenLabs API key above ↑', false);
  };

  // ── Cross-tab: Claude chat can push script/SFX to Voice Gen ───────────────
  window.VoiceGenPushScript = function(text, voiceId, autoGenerate, switchTab) {
    // Switch to Voice Gen tab (unless switchTab === false → background prepare)
    if (switchTab !== false) {
      var vgBtn = document.querySelector('.tab-btn[data-tab="voicegen"]');
      if (vgBtn) vgBtn.click();
    }
    // Switch to TTS mode
    switchMode('tts');
    // Set script text
    if (els.script) {
      els.script.value = text || '';
      updateCharCount();
      vgAutoResize(els.script);
    }
    // Set voice if provided
    if (voiceId) {
      vgSetVoice(voiceId);
      // sync active speaker
      var sp = VG_SPEAKERS.find(function(s) { return s.id === VG_ACTIVE_SPEAKER; });
      if (sp) sp.voiceId = voiceId;
      renderSpeakerBar();
    }
    // Auto-generate or focus generate button
    if (autoGenerate) {
      setTimeout(function() { generate(); }, 200);
    } else {
      setTimeout(function() {
        if (els.btnGenerate) { try { els.btnGenerate.focus(); } catch(e) {} }
      }, 100);
    }
  };

  window.VoiceGenPushSFX = function(text, autoGenerate) {
    // Switch to Voice Gen tab
    var vgBtn = document.querySelector('.tab-btn[data-tab="voicegen"]');
    if (vgBtn) vgBtn.click();
    // Switch to SFX mode
    switchMode('sfx');
    // Set SFX text
    var sfxEl = $('vgSfxText');
    if (sfxEl) {
      sfxEl.value = text || '';
      var cnt = $('vgSfxCharCount');
      if (cnt) cnt.textContent = (text || '').length + ' / 500';
    }
    if (autoGenerate) {
      setTimeout(function() { generate(); }, 200);
    } else {
      setTimeout(function() {
        if (els.btnGenerate) { try { els.btnGenerate.focus(); } catch(e) {} }
      }, 100);
    }
  };

  // Wire mode buttons
  document.querySelectorAll('.vg-modeBtn').forEach(function(btn) {
    btn.addEventListener('click', function() { switchMode(btn.dataset.mode); });
  });

  // Hook a number input — set initial value, clamp to min/max, sync label,
  // and inject custom ±  buttons (UXP Chromium doesn't render native spinners).
  function hookSlider(inputId, labelId, defaultVal, formatter) {
    var s = $(inputId), v = $(labelId);
    if (!s) return;

    // Read constraints from element attributes
    var minV = (s.min !== '' && s.min != null) ? parseFloat(s.min) : -Infinity;
    var maxV = (s.max !== '' && s.max != null) ? parseFloat(s.max) : Infinity;
    var stepV = (s.step && s.step !== '' && s.step !== 'any') ? parseFloat(s.step) : 1;
    var precision = (String(stepV).split('.')[1] || '').length; // decimal places of step

    function clamp(n) {
      if (isNaN(n)) return defaultVal;
      if (minV !== -Infinity) n = Math.max(minV, n);
      if (maxV !== Infinity)  n = Math.min(maxV, n);
      return parseFloat(n.toFixed(precision));
    }

    s.value = String(defaultVal);

    function update() {
      var n = clamp(parseFloat(s.value));
      s.value = String(n);
      if (v) v.textContent = formatter(n);
    }

    s.addEventListener('input',  update);
    s.addEventListener('change', update);
    s.addEventListener('blur',   update);

    // Mouse-wheel: scroll while focused — clamp to bounds
    s.addEventListener('wheel', function(e) {
      e.preventDefault();
      var n = clamp(parseFloat(s.value) || defaultVal);
      n = clamp(e.deltaY < 0 ? n + stepV : n - stepV);
      s.value = String(n);
      if (v) v.textContent = formatter(n);
    });

    // Custom ± buttons — UXP Chromium omits native input[type=number] spinners
    var numRow = s.parentElement;
    if (numRow && numRow.classList.contains('vg-numRow')) {
      var btnMinus = document.createElement('button');
      btnMinus.type = 'button';
      btnMinus.className = 'vg-stepBtn';
      btnMinus.textContent = '−';
      btnMinus.addEventListener('click', function() {
        s.value = String(clamp((parseFloat(s.value) || defaultVal) - stepV));
        update();
      });

      var btnPlus = document.createElement('button');
      btnPlus.type = 'button';
      btnPlus.className = 'vg-stepBtn';
      btnPlus.textContent = '+';
      btnPlus.addEventListener('click', function() {
        s.value = String(clamp((parseFloat(s.value) || defaultVal) + stepV));
        update();
      });

      numRow.insertBefore(btnMinus, s);
      var nextSib = s.nextSibling; // vg-nu label or null
      if (nextSib) numRow.insertBefore(btnPlus, nextSib);
      else         numRow.appendChild(btnPlus);
    }

    update();
  }

  // SFX/Music params: same custom drag-slider as the Tạo Sub tab (UXP native
  // range can't drag). The number box keeps its ID so generate() reads it as before.
  function vgMakeCSlider(sliderId, numId) {
    var s = $(sliderId), n = $(numId);
    if (!s || !n) return;
    var min = parseFloat(s.dataset.min), max = parseFloat(s.dataset.max);
    var step = parseFloat(s.dataset.step) || 1;
    var decimals = (String(step).split('.')[1] || '').length;
    var fill = s.querySelector('.st-cfill'), thumb = s.querySelector('.st-cthumb');
    var dragging = false;
    function render(v) {
      var pct = max > min ? (v - min) / (max - min) : 0;
      pct = Math.max(0, Math.min(1, pct)) * 100;
      if (fill) fill.style.width = pct + '%';
      if (thumb) thumb.style.left = pct + '%';
    }
    function setVal(v, fromInput) {
      if (isNaN(v)) return;
      v = Math.round(v / step) * step;
      v = Math.max(min, Math.min(max, parseFloat(v.toFixed(decimals))));
      if (!fromInput) n.value = v;
      render(v);
    }
    function valFromX(cx) { var r = s.getBoundingClientRect(); var pct = r.width ? (cx - r.left) / r.width : 0; return min + Math.max(0, Math.min(1, pct)) * (max - min); }
    s.addEventListener('pointerdown', function (e) { dragging = true; setVal(valFromX(e.clientX)); });
    window.addEventListener('pointermove', function (e) { if (dragging) setVal(valFromX(e.clientX)); });
    window.addEventListener('pointerup', function () { dragging = false; });
    n.addEventListener('input', function () { setVal(parseFloat(n.value), true); });
    n.addEventListener('change', function () { setVal(parseFloat(n.value)); });
    n.addEventListener('blur', function () { setVal(parseFloat(n.value)); });
    setVal(parseFloat(n.value));
  }
  vgMakeCSlider('vgSfxDurationC',  'vgSfxDuration');
  vgMakeCSlider('vgSfxInfluenceC', 'vgSfxInfluence');
  vgMakeCSlider('vgMusicLengthC',  'vgMusicLength');

  // SFX char count + auto-resize
  var sfxText = $('vgSfxText');
  if (sfxText) {
    sfxText.addEventListener('input', function() {
      $('vgSfxCharCount').textContent = safeLen(sfxText) + ' / 500';
      vgAutoResize(sfxText);
    });
    sfxText.addEventListener('paste', function() { setTimeout(function() { vgAutoResize(sfxText); }, 0); });
  }

  // Music char count + auto-resize
  var musicPrompt = $('vgMusicPrompt');
  if (musicPrompt) {
    musicPrompt.addEventListener('input', function() {
      $('vgMusicCharCount').textContent = safeLen(musicPrompt) + ' / 1000';
      vgAutoResize(musicPrompt);
    });
    musicPrompt.addEventListener('paste', function() { setTimeout(function() { vgAutoResize(musicPrompt); }, 0); });
  }

  // Wire setKeyboardFocus for all VoiceGen text inputs (prevent Premiere shortcut conflicts)
  [$('vgScript'), sfxText, musicPrompt, $('vgProfileName'), $('vgElKeyInput'), $('vgCustomVoiceId'),
   $('vgFilename'), $('vgOutputFolder')].forEach(function(el) {
    if (!el) return;
    el.addEventListener('focus', window.claimKeyboard);
    el.addEventListener('blur',  window.releaseKeyboard);
  });

  // ── Voice dropdown init ──────────────────────────────────────────────────
  // Seed VG_VOICES_DATA from the static default <option> elements
  (function() {
    var opts = els.voiceSelect ? els.voiceSelect.options : [];
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      if (!o.value || o.disabled) continue;
      VG_VOICES_DATA.push({ voice_id: o.value, label: o.textContent, preview_url: '', isDefault: true });
    }
  })();

  // Portal the dropdown panel to #tab-voicegen (position:relative) so it escapes
  // .vg-right's overflow:auto without needing position:fixed (unsupported in UXP).
  // DOM order: appended last → paints on top of siblings per UXP paint rules.
  var vgDropPanel = $('vgVoiceDropPanel');
  var vgTabPanel  = document.getElementById('tab-voicegen');
  if (vgDropPanel) (vgTabPanel || document.body).appendChild(vgDropPanel);

  // Wire dropdown trigger
  var dropTrigger = $('vgVoiceDropTrigger');
  if (dropTrigger) dropTrigger.addEventListener('click', function() {
    var panel = $('vgVoiceDropPanel');
    if (panel && panel.style.display === 'flex') closeVoiceDrop(); else openVoiceDrop();
  });

  // Close on outside click — must check BOTH the trigger container AND the portaled panel
  document.addEventListener('click', function(e) {
    var drop  = $('vgVoiceDrop');
    var panel = $('vgVoiceDropPanel');
    var inDrop  = drop  && drop.contains(e.target);
    var inPanel = panel && panel.contains(e.target);
    if (!inDrop && !inPanel) closeVoiceDrop();
  });

  // Init — each step in its own try so one failure doesn't stop the rest
  console.log('[VoiceGen] init v4.2.0, ELEVENLABS_KEY present:', !!ELEVENLABS_KEY,
              '| length:', (ELEVENLABS_KEY || '').length);
  try { updateCharCount(); }        catch(e) { console.warn('[VG] updateCharCount:', e.message); }
  try { players.var1 = createPlayer('var1'); } catch(e) { console.error('[VG] createPlayer var1:', e.message); }
  try { players.var2 = createPlayer('var2'); } catch(e) { console.error('[VG] createPlayer var2:', e.message); }
  try { renderSpeakerBar(); } catch(e) { console.warn('[VG] renderSpeakerBar:', e.message); }
  try { renderVoiceDrop(); }  catch(e) { console.warn('[VG] renderVoiceDrop:', e.message); }
  if (ELEVENLABS_KEY) {
    try { loadVoices(); } catch(e) { console.warn('[VG] loadVoices:', e.message); }
  } else {
    setStatus('Set ElevenLabs API key in Settings ⚙', false);
  }

  // Poll for project change every 5 s — reset output folder when user switches projects
  // so stale folder paths from the previous project don't carry over.
  var _vgProjectId = null;
  setInterval(async function() {
    try {
      if (!ppro || !ppro.Project) return;
      var proj = await getActiveProject();
      var pid = (typeof proj.path === 'string' && proj.path) || proj.name || '';
      if (_vgProjectId !== null && pid && pid !== _vgProjectId) {
        resetOutputFolder();
        console.log('[VoiceGen] project changed → output folder reset');
      }
      if (pid) _vgProjectId = pid;
    } catch(e) {}
  }, 5000);
})();

// ════════════════════════════════════════════════════════════════════════════
// TẠO SUB MODULE — standalone subtitle (.srt) from timeline audio
// Reads checked audio tracks → concat (bridge ffmpeg) → Whisper → .srt → import.
// ════════════════════════════════════════════════════════════════════════════
(function() {
  function $(id) { return document.getElementById(id); }
  var stTracks = [];     // [{index, name, count, track}]
  var stLastPath = null; // last generated .srt path (for the reveal button)
  var stAbort = null;    // AbortController for the in-flight /subtext fetch (cancel)
  var stBusy  = false;   // true while making SRT → button acts as Cancel

  function stStatus(msg) {
    var el = $('stStatus'); if (!el) return;
    el.textContent = msg || ''; el.style.display = msg ? 'block' : 'none';
  }

  // Auto-grow the script box via its sizer (UXP textareas don't scroll).
  function stAutoResize() {
    var el = $('stScript'), sizer = $('stScriptSizer');
    if (el && sizer) sizer.textContent = (el.value || '') + '\n';
  }

  async function stScanTracks() {
    var listEl = $('stTrackList');
    var seqEl  = $('stSeqName');
    stTracks = [];
    try {
      var seq = await getActiveSequence();
      if (!seq) {
        if (seqEl) seqEl.textContent = '— chưa mở sequence';
        if (listEl) listEl.innerHTML = '<div class="st-trackEmpty">⚠ Chưa mở sequence nào.</div>';
        return;
      }
      if (seqEl) seqEl.textContent = '· ' + (seq.name || 'sequence');
      var cnt = seq.getAudioTrackCount ? seq.getAudioTrackCount() : 0;
      if (cnt && typeof cnt.then === 'function') cnt = await cnt;
      cnt = cnt || 0;
      for (var i = 0; i < cnt; i++) {
        var tr = seq.getAudioTrack(i);
        if (tr && typeof tr.then === 'function') tr = await tr;
        if (!tr) continue;
        var items = [];
        try { items = await getClipItems(tr); } catch (e) {}
        stTracks.push({ index: i, name: 'A' + (i + 1), count: (items || []).length, track: tr });
      }
      stRenderTracks();
    } catch (e) {
      if (listEl) listEl.innerHTML = '<div class="st-trackEmpty">❌ ' + e.message + '</div>';
    }
  }

  function stRenderTracks() {
    var listEl = $('stTrackList'); if (!listEl) return;
    listEl.innerHTML = '';
    if (!stTracks.length) {
      listEl.innerHTML = '<div class="st-trackEmpty">Không có track audio — mở sequence rồi thử lại.</div>';
      return;
    }
    // Show ALL tracks (no A1→A3 gaps); empty tracks are dimmed + disabled, not hidden.
    stTracks.forEach(function (t) {
      var empty = t.count === 0;
      // NOTE: a <label> wrapping the checkbox makes UXP render the adjacent text as the
      // checkbox's "control label" in a muted theme colour (ignores CSS color). Use a
      // <div> + manual toggle so the track name renders with our white CSS colour.
      var row = document.createElement('div');
      row.className = 'st-trackRow' + (empty ? ' is-empty' : '');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !empty;     // only tracks with clips ticked by default
      cb.disabled = empty;     // empty tracks can't be selected
      cb.dataset.trackIdx = String(t.index);
      var nm = document.createElement('span'); nm.className = 'st-trackName'; nm.textContent = t.name;
      var meta = document.createElement('span'); meta.className = 'st-trackMeta';
      meta.textContent = empty ? 'trống' : (t.count + ' clip');
      row.appendChild(cb); row.appendChild(nm); row.appendChild(meta);
      if (!empty) {
        row.addEventListener('click', function (e) {
          if (e.target === cb) return;        // clicking the box itself toggles natively
          cb.checked = !cb.checked;
        });
      }
      listEl.appendChild(row);
    });
  }

  // Collect clips from checked tracks → [{filePath,inPoint,outPoint,start}] sorted by timeline start.
  async function stCollectClips() {
    var checked = Array.prototype.slice.call(document.querySelectorAll('#stTrackList input[type=checkbox]'))
      .filter(function (cb) { return cb.checked; })
      .map(function (cb) { return parseInt(cb.dataset.trackIdx, 10); });
    if (!checked.length) return [];
    var out = [];
    for (var k = 0; k < stTracks.length; k++) {
      var t = stTracks[k];
      if (checked.indexOf(t.index) === -1) continue;
      var items = [];
      try { items = await getClipItems(t.track); } catch (e) { continue; }
      for (var j = 0; j < items.length; j++) {
        var it = items[j];
        var fp = null;
        try { fp = await vcGetTrackItemFilePath(it); } catch (e) {}
        if (!fp) continue;
        var inSec = 0, outSec = 0, startSec = 0;
        try {
          var ip = it.getInPoint && it.getInPoint(); if (ip && ip.then) ip = await ip; inSec = getTimeSec(ip);
          var op = it.getOutPoint && it.getOutPoint(); if (op && op.then) op = await op; outSec = getTimeSec(op);
          // Timeline position: UXP trackitems expose getStartTime() (sequence time);
          // getStart() is absent on these items → was always 0, which collapsed all
          // timeline gaps (silence never inserted). Prefer getStartTime, fall back.
          var startFn = it.getStartTime || it.getStart;
          var sps = startFn ? startFn.call(it) : null; if (sps && sps.then) sps = await sps; startSec = getTimeSec(sps);
        } catch (e) {}
        inSec = Math.max(0, inSec); outSec = Math.max(0, outSec); // guard tiny negative FP (ffmpeg -ss)
        if (outSec <= inSec) continue;
        out.push({ filePath: fp, inPoint: inSec, outPoint: outSec, start: Math.max(0, startSec) });
      }
    }
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  // Own import (SAC's sacFindOrImportFile lives in another IIFE).
  async function stImportFile(filePath) {
    var proj = await getActiveProject();
    if (!proj) throw new Error('Không có project đang mở');
    if (typeof proj.importFiles === 'function') await proj.importFiles([filePath]);
    else if (typeof proj.importFile === 'function') await proj.importFile(filePath);
    else throw new Error('No importFiles API');
  }

  async function stMakeSrt() {
    var btn = $('stMakeBtn');
    stBusy = true;
    stAbort = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    // Button stays clickable but flips to Cancel mode (don't .disable it).
    if (btn) { btn.classList.add('is-cancel'); piSetBtn(btn, 'xmark', 'Huỷ', '#ffffff', 13); }
    try {
      stStatus('⏳ Đọc clip audio từ timeline...');
      var clips = await stCollectClips();
      if (!clips.length) { stStatus('⚠ Chưa chọn track có clip audio (bấm 🔄 Quét track rồi tick).'); return; }

      var scriptRaw = ($('stScript') && $('stScript').value || '').trim();
      var scriptLines = scriptRaw ? scriptRaw.split('\n').map(function (s) { return s.trim(); }).filter(Boolean) : [];
      var maxWords = parseInt(($('stMaxWords') || {}).value, 10) || 5;
      var maxChars = parseInt(($('stMaxChars') || {}).value, 10) || 30;
      var maxDur   = parseFloat(($('stMaxDur') || {}).value) || 3;

      var folder = localStorage.getItem('vg_last_save_folder') || '';
      if (!folder) {
        try {
          var lfs = require('uxp').storage.localFileSystem;
          var f = await lfs.getFolder();
          if (!f) { stStatus('Đã huỷ — chưa chọn thư mục lưu.'); return; }
          folder = f.nativePath || f.path || '';
          if (folder) localStorage.setItem('vg_last_save_folder', folder);
        } catch (e) { stStatus('Không chọn được thư mục: ' + e.message); return; }
      }
      var outputPath = folder.replace(/[\/\\]+$/, '') + '/subtitle_' + Date.now() + '.srt';

      var useAI = !($('stUseAI')) || $('stUseAI').checked;  // default on
      var aiCfg = (useAI && window.sacOrganizeConfig) ? window.sacOrganizeConfig() : {};
      // Cancelled during the (interactive) clip/folder steps before the request went out.
      if (stAbort && stAbort.signal.aborted) { stStatus('⏹ Đã huỷ tạo phụ đề.'); return; }
      stStatus('⏳ Ghép ' + clips.length + ' clip + Whisper canh giờ' + (useAI ? ' + AI ngắt câu' : '') + '... (có thể mất 1-2 phút · bấm Huỷ để dừng)');
      var resp = await fetch(BRIDGE_URL + '/superautocut/subtext', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clips: clips, scriptLines: scriptLines, outputPath: outputPath,
          maxWords: maxWords, maxChars: maxChars, maxDur: maxDur,
          useAI: useAI, provider: aiCfg.provider, model: aiCfg.model, apiKey: aiCfg.apiKey }),
        signal: stAbort ? stAbort.signal : undefined,
      });
      var d = await resp.json();
      if (!d || !d.ok) { stStatus('❌ ' + ((d && d.error) || 'Tạo SRT thất bại')); return; }

      stLastPath = d.path;
      var ar = $('stAfterRow'); if (ar) ar.style.display = 'flex';
      stStatus('⏳ Import .srt vào project...');
      var imported = true;
      try { await stImportFile(d.path); } catch (e) { imported = false; }
      stStatus('✅ ' + d.cues.length + ' dòng phụ đề → "' + d.path.split('/').pop() + '"' +
        (imported ? ' · đã import vào project — kéo từ bin xuống timeline.'
                  : ' · đã lưu (chưa import được — bấm 📂 mở thư mục rồi kéo .srt vào project).'));
    } catch (e) {
      if (e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) stStatus('⏹ Đã huỷ tạo phụ đề.');
      else stStatus('❌ ' + e.message);
    } finally {
      stBusy = false; stAbort = null;
      if (btn) { btn.classList.remove('is-cancel'); piSetBtn(btn, 'closed_captioning', 'Tạo SRT', '#ffffff', 14); }
    }
  }

  // The make button doubles as Cancel while a run is in flight.
  var makeBtn = $('stMakeBtn');
  if (makeBtn) makeBtn.addEventListener('click', function () {
    if (stBusy) { if (stAbort) stAbort.abort(); return; }
    stMakeSrt();
  });
  var revealBtn = $('stRevealBtn');
  if (revealBtn) revealBtn.addEventListener('click', async function () {
    if (!stLastPath) return;
    try {
      await fetch(BRIDGE_URL + '/tts/reveal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: stLastPath }),
      });
    } catch (e) { stStatus('❌ Không mở được thư mục: ' + e.message); }
  });
  var importBtn = $('stImportBtn');
  if (importBtn) importBtn.addEventListener('click', async function () {
    if (!stLastPath) return;
    try {
      await stImportFile(stLastPath);
      stStatus('✅ Đã import "' + stLastPath.split('/').pop() + '" vào project — tìm trong bin gốc.');
    } catch (e) { stStatus('❌ Import lỗi: ' + e.message + ' — dùng 📂 Mở Finder rồi kéo vào.'); }
  });

  // Custom slider: UXP native <input type=range> won't drag, so drive a div+thumb
  // via pointer events and keep it two-way synced with the number box (clamped).
  function makeCSlider(sliderId, numId) {
    var s = $(sliderId), n = $(numId);
    if (!s || !n) return;
    var min  = parseFloat(s.dataset.min), max = parseFloat(s.dataset.max);
    var step = parseFloat(s.dataset.step) || 1;
    var decimals = (String(step).split('.')[1] || '').length;
    var fill = s.querySelector('.st-cfill'), thumb = s.querySelector('.st-cthumb');
    var dragging = false;
    function render(v) {
      var pct = max > min ? (v - min) / (max - min) : 0;
      pct = Math.max(0, Math.min(1, pct)) * 100;
      if (fill)  fill.style.width = pct + '%';
      if (thumb) thumb.style.left = pct + '%';
    }
    function setVal(v, fromInput) {
      if (isNaN(v)) return;
      v = Math.round(v / step) * step;
      v = Math.max(min, Math.min(max, parseFloat(v.toFixed(decimals))));
      if (!fromInput) n.value = v;
      render(v);
    }
    function valFromX(clientX) {
      var r = s.getBoundingClientRect();
      var pct = r.width ? (clientX - r.left) / r.width : 0;
      return min + Math.max(0, Math.min(1, pct)) * (max - min);
    }
    s.addEventListener('pointerdown', function (e) { dragging = true; setVal(valFromX(e.clientX)); });
    window.addEventListener('pointermove', function (e) { if (dragging) setVal(valFromX(e.clientX)); });
    window.addEventListener('pointerup', function () { dragging = false; });
    n.addEventListener('input',  function () { setVal(parseFloat(n.value), true); });
    n.addEventListener('change', function () { setVal(parseFloat(n.value)); });
    n.addEventListener('blur',   function () { setVal(parseFloat(n.value)); });
    setVal(parseFloat(n.value)); // init thumb position
  }
  makeCSlider('stMaxWordsC', 'stMaxWords');
  makeCSlider('stMaxCharsC', 'stMaxChars');
  makeCSlider('stMaxDurC',   'stMaxDur');

  ['stScript', 'stMaxWords', 'stMaxChars', 'stMaxDur'].forEach(function (id) {
    var el = $(id);
    if (el) {
      el.addEventListener('focus', function () { if (window.claimKeyboard) window.claimKeyboard(); });
      el.addEventListener('blur',  function () { if (window.releaseKeyboard) window.releaseKeyboard(); });
    }
  });
  var stScriptEl = $('stScript');
  if (stScriptEl) { stScriptEl.addEventListener('input', stAutoResize); stAutoResize(); }

  // Auto-scan when the Tạo Sub tab is opened…
  var subTabBtn = document.querySelector('.tab-btn[data-tab="subtext"]');
  if (subTabBtn) subTabBtn.addEventListener('click', function () { stScanTracks(); });
  // …and whenever the active sequence changes (pollTimeline calls this), if visible.
  window.__subtextSync = function () {
    var panel = document.getElementById('tab-subtext');
    if (panel && panel.classList.contains('active')) stScanTracks();
  };
})();

// ═══════════════════════════════════════════════════════════════════════════
// UN-NEST MODULE — expand selected nested sequences onto new tracks (1 click)
// Uses global helpers: ppro, getActiveProject, getActiveSequence,
//                      getClipItems, getTimeSec
// ═══════════════════════════════════════════════════════════════════════════
(function() {
  var $ = function(id) { return document.getElementById(id); };
  var els = {
    refresh:     $('unRefresh'),
    hint:        $('unHint'),
    count:       $('unCount'),
    list:        $('unList'),
    disableOrig: $('unDisableOrig'),
    run:         $('unRun'),
    log:         $('unLog'),
  };
  if (!els.run) return; // tab not present

  // Read the selected expand mode: 'video' | 'av' | 'avt'
  function getMode() {
    var r = document.querySelector('input[name="unMode"]:checked');
    return r ? r.value : 'av';
  }

  var EPS = 0.0006;            // seconds tolerance for overlap math
  var UNNEST_PAD = 2.0;        // seconds: max overflow kept beyond the nested region
  var detected = [];           // unique nested clips
  var rawSelected = [];        // every selected track item (for disabling originals)
  var canRun = false;          // gates the run() handler (un-nest button is a <div>)
  var busy = false;            // gates re-entry while a scan/run is in flight

  // ── small helpers ─────────────────────────────────────────────────────────
  function setRunEnabled(on) {
    canRun = !!on;
    els.run.setAttribute('aria-disabled', on ? 'false' : 'true');
  }
  function logLine(msg, cls) {
    if (!els.log) return;
    els.log.hidden = false;
    var span = document.createElement('div');
    if (cls) span.className = cls;
    span.textContent = msg;
    els.log.appendChild(span);
    els.log.scrollTop = els.log.scrollHeight;
  }
  function clearLog() { if (els.log) { els.log.textContent = ''; els.log.hidden = true; } }

  async function un(v) { return (v && typeof v.then === 'function') ? await v : v; }

  async function callSec(obj, method) {
    try {
      if (!obj || typeof obj[method] !== 'function') return null;
      var r = await un(obj[method]());
      return getTimeSec(r);
    } catch (e) { return null; }
  }

  async function awaitArray(v) {
    v = await un(v);
    if (!v) return [];
    if (Array.isArray(v)) return v;
    var n = v.length || 0, out = [];
    for (var i = 0; i < n; i++) out.push(v[i]);
    return out;
  }

  function asClipPI(projItem) {
    try {
      if (ppro.ClipProjectItem && typeof ppro.ClipProjectItem.cast === 'function') {
        return ppro.ClipProjectItem.cast(projItem) || null;
      }
    } catch (e) {}
    return null;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function fmt(sec) {
    sec = sec || 0;
    var m = Math.floor(sec / 60), s = sec - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  }

  // ── DETECT: read selection, find nested-sequence clips ──────────────────────
  // opts.silent = true → triggered by auto-poll; don't flash UI / clear the log.
  function setCount(t) { if (els.count) els.count.textContent = t; }
  function setList(html) { if (els.list) els.list.innerHTML = html; }

  async function detect(opts) {
    if (busy) return;
    var silent = opts && opts.silent;
    busy = true;
    detected = [];
    rawSelected = [];
    if (!silent) {
      clearLog();
      setCount('đang quét…');
      setList('<div class="un-empty">Đang quét vùng chọn…</div>');
    }
    setRunEnabled(false);

    try {
      if (!ppro) throw new Error('Premiere API không khả dụng.');
      var seq = await getActiveSequence();
      var sel = await un(seq.getSelection());
      if (!sel) throw new Error('Không lấy được vùng chọn.');
      rawSelected = await awaitArray(sel.getTrackItems());

      if (rawSelected.length === 0) {
        setCount('0 clip');
        setList('<div class="un-empty">Chưa chọn clip nào. Click chọn clip nested trên timeline — plugin sẽ tự nhận.</div>');
        return;
      }

      var seenIds = {};
      var nonNested = 0;
      for (var i = 0; i < rawSelected.length; i++) {
        var item = rawSelected[i];
        var projItem = await un(item.getProjectItem ? item.getProjectItem() : null);
        if (!projItem) continue;
        var clipPI = asClipPI(projItem);
        var isSeq = false;
        try { isSeq = clipPI ? await un(clipPI.isSequence()) : false; } catch (e) {}
        if (!isSeq) { nonNested++; continue; }

        var id = '';
        try { id = await un(projItem.getId()); } catch (e) {}
        var startSec = await callSec(item, 'getStartTime');
        var key = id + '@' + (startSec == null ? '?' : startSec.toFixed(3));
        if (seenIds[key]) continue;   // dedupe linked V/A items of same nest
        seenIds[key] = true;

        var name = '';
        try { name = await un(item.getName ? item.getName() : item.name); } catch (e) {}
        var nestedSeq = null;
        try { nestedSeq = await un(clipPI.getSequence()); } catch (e) {}

        detected.push({
          item: item,
          name: name || ('Nested ' + (detected.length + 1)),
          projItem: projItem,
          nestedSeq: nestedSeq,
          parentStart: startSec || 0,
          nestIn:  await callSec(item, 'getInPoint'),
          nestOut: await callSec(item, 'getOutPoint'),
          ok: !!nestedSeq,
        });
      }

      renderList(nonNested);
    } catch (e) {
      setCount('lỗi');
      setList('<div class="un-empty">⚠ ' + escapeHtml(e.message || e) + '</div>');
      console.error('[Un-nest] detect error:', e);
    } finally {
      busy = false;
    }
  }

  function renderList(nonNested) {
    setCount(detected.length + ' nested');
    if (detected.length === 0) {
      var msg = nonNested > 0
        ? ('Vùng chọn có ' + nonNested + ' clip nhưng không phải nested sequence.')
        : 'Không tìm thấy nested sequence trong vùng chọn.';
      setList('<div class="un-empty">' + msg + '</div>');
      setRunEnabled(false);
      return;
    }
    if (els.list) {
      els.list.innerHTML = '';
      for (var i = 0; i < detected.length; i++) {
        var d = detected[i];
        var div = document.createElement('div');
        div.className = 'un-item' + (d.ok ? '' : ' is-bad');
        var inS  = (d.nestIn  == null) ? 0 : d.nestIn;
        var outS = (d.nestOut == null) ? 0 : d.nestOut;
        var html = '<div class="un-itemName">' + escapeHtml(d.name) + '</div>'
          + '<div class="un-itemMeta">@ ' + fmt(d.parentStart) + ' trên timeline · đoạn cắt '
          + fmt(inS) + '–' + fmt(outS) + ' (' + fmt(Math.max(0, outS - inS)) + ')</div>';
        if (!d.ok) html += '<div class="un-itemBad">⚠ Không đọc được nội dung nested — sẽ bỏ qua.</div>';
        div.innerHTML = html;
        els.list.appendChild(div);
      }
    }
    setRunEnabled(true);
  }


  // ── small timing helpers (used when re-focusing the parent to disable originals) ──
  var SETTLE_SHORT = 280;
  function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  async function openAndActivate(project, seq) {
    try { if (typeof project.openSequence === 'function') await un(project.openSequence(seq)); } catch (e) {}
    try { if (typeof project.setActiveSequence === 'function') await un(project.setActiveSequence(seq)); } catch (e) {}
  }
  // ── EXPAND via API clone (no sequence switch, no overwrite, keeps effects) ──
  // Clones each inner clip of the nested's cut range onto NEW parent tracks
  // (above existing content) using SequenceEditor.createCloneTrackItemAction —
  // which preserves effects. One transaction = one undo step. Track index is
  // absolute (auto-creates high tracks); time is an offset added to each item's
  // own start, so item at nested-time T lands at parentStart + (T - nestIn).
  // Overflow trim: feature-detected at runtime (no console probe available).
  //   TAIL → trackItem.createSetInOutPointsAction(inPt, outPt) when present.
  //   HEAD → trackItem.createMoveTrackItemAction(startTT, false) when present; else tail-only + log.
  async function expandViaClone(project, parentSeq, d, mode) {
    if (!d.ok || !d.nestedSeq) { logLine('· bỏ qua "' + d.name + '" (không đọc được nội dung)', 'warn'); return 0; }
    var nested = d.nestedSeq;
    var nestIn = d.nestIn || 0, nestOut = d.nestOut || 0, parentStart = d.parentStart || 0;
    var ed = ppro.SequenceEditor.getEditor(parentSeq);
    var TT = function (s) { return ppro.TickTime.createWithSeconds(Math.max(0, s)); };
    var timeOffset = parentStart - nestIn;

    var pv = 0, pa = 0;
    try { pv = await un(parentSeq.getVideoTrackCount()); } catch (e) {}
    try { pa = await un(parentSeq.getAudioTrackCount()); } catch (e) {}

    // Paste window on the parent timeline (whole clips can overflow a bit — matches
    // the cut-range mapping). Clones must always land ON TOP of whatever is at this
    // window: a track is reusable only if it (a) has no clip overlapping the window
    // AND (b) sits ABOVE the highest track that DOES have content in the window. Such
    // a track may still hold clips elsewhere on the timeline — only the window matters.
    // We fill those (ascending, preserving layer order) before adding new tracks on top.
    var winStart = parentStart, winEnd = parentStart + Math.max(0, nestOut - nestIn);
    var overlapsWin = function (s, e) { return s < winEnd - EPS && e > winStart + EPS; };
    async function freeTracks(count, getTrack) {
      // First pass: mark which tracks are busy in the window and find the topmost busy one.
      var busyMap = [], topBusy = -1;
      for (var t = 0; t < count; t++) {
        var trk = await un(getTrack(t));
        var clips = await getClipItems(trk);
        var busyTrk = false;
        for (var i = 0; i < clips.length; i++) {
          var cs = await callSec(clips[i], 'getStartTime'), ce = await callSec(clips[i], 'getEndTime');
          if (cs != null && ce != null && overlapsWin(cs, ce)) { busyTrk = true; break; }
        }
        busyMap[t] = busyTrk;
        if (busyTrk) topBusy = t;
      }
      // Reusable = every track above the topmost busy one (all free in the window by
      // definition). Tracks below/at content in the window are skipped → clone goes on top.
      var free = [];
      for (var t2 = topBusy + 1; t2 < count; t2++) free.push(t2);
      return free;
    }
    var freeV = await freeTracks(pv, function (t) { return parentSeq.getVideoTrack(t); });
    var freeA = (mode === 'av' || mode === 'avt') ? await freeTracks(pa, function (t) { return parentSeq.getAudioTrack(t); }) : [];
    var newV = pv, newA = pa, reusedV = 0, reusedA = 0;
    var nextV = function () { if (freeV.length) { reusedV++; return freeV.shift(); } return newV++; };
    var nextA = function () { if (freeA.length) { reusedA++; return freeA.shift(); } return newA++; };

    // Gather clone targets (async) first, then apply in ONE transaction. Each nested
    // track that contributes clips gets its OWN parent target track (reused or new).
    var targets = []; // { item, vIdx, aIdx, align }
    var inRange = function (s, e) { return (Math.min(e, nestOut) - Math.max(s, nestIn)) > EPS; };
    var vfDropped = 0;

    var nv = 0; try { nv = await un(nested.getVideoTrackCount()); } catch (e) {}
    for (var vi = 0; vi < nv; vi++) {
      var vt = await un(nested.getVideoTrack(vi));
      var vc = await getClipItems(vt);
      var picked = [];
      for (var c = 0; c < vc.length; c++) {
        var s1 = await callSec(vc[c], 'getStartTime'), e1 = await callSec(vc[c], 'getEndTime');
        if (s1 == null || e1 == null || !inRange(s1, e1)) continue;
        if (mode === 'video' || mode === 'av') {
          var cls = await classifyVideoClip(vc[c]);
          if (!cls.keep) { vfDropped++; continue; } // pure text/title → skip
        }
        picked.push(vc[c]);
      }
      if (!picked.length) continue;
      var vIdx = nextV();
      for (var pk = 0; pk < picked.length; pk++) targets.push({ item: picked[pk], vIdx: vIdx, aIdx: 0, align: true });
    }
    if (mode === 'av' || mode === 'avt') {
      var na = 0; try { na = await un(nested.getAudioTrackCount()); } catch (e) {}
      for (var ai = 0; ai < na; ai++) {
        var at = await un(nested.getAudioTrack(ai));
        var ac = await getClipItems(at);
        var apick = [];
        for (var b = 0; b < ac.length; b++) {
          var s2 = await callSec(ac[b], 'getStartTime'), e2 = await callSec(ac[b], 'getEndTime');
          if (s2 == null || e2 == null || !inRange(s2, e2)) continue;
          apick.push(ac[b]);
        }
        if (!apick.length) continue;
        var aIdx = nextA();
        for (var qk = 0; qk < apick.length; qk++) targets.push({ item: apick[qk], vIdx: 0, aIdx: aIdx, align: false });
      }
    }

    if (!targets.length) { logLine('· "' + d.name + '": không có clip trong đoạn cắt', 'warn'); return 0; }

    // Snapshot every existing track's clips BEFORE cloning, so the new clones can be
    // found by set-difference afterward. We scan ALL tracks (not just our requested
    // target indices) because the clone action can place clips on tracks that don't
    // match the requested vIdx and can create extra high tracks. This is robust vs
    // matching by start time (which breaks on stills, duplicate starts, negative offsets).
    async function _clipKey(c) {
      try { if (typeof c.getGuid === 'function') { var g = await un(c.getGuid()); if (g != null) return 'g:' + (g.toString ? g.toString() : g); } } catch (e) {}
      var s = await callSec(c, 'getStartTime'); return 's:' + (s == null ? '?' : s.toFixed(3));
    }
    var beforeV = {}, beforeA = {};
    for (var bv = 0; bv < pv; bv++) {
      var bvt = await un(parentSeq.getVideoTrack(bv)); var bvs = {};
      var bvc = bvt ? await getClipItems(bvt) : []; for (var bx = 0; bx < bvc.length; bx++) bvs[await _clipKey(bvc[bx])] = 1;
      beforeV[bv] = bvs;
    }
    for (var ba = 0; ba < pa; ba++) {
      var bat = await un(parentSeq.getAudioTrack(ba)); var bas = {};
      var bac = bat ? await getClipItems(bat) : []; for (var by = 0; by < bac.length; by++) bas[await _clipKey(bac[by])] = 1;
      beforeA[ba] = bas;
    }

    var done = 0;
    // Use the real (possibly negative) clone offset. TT() clamps to ≥0, which shifted
    // all clips right when the nested clip sits near the timeline start (parentStart <
    // nestIn); passing the true offset keeps them aligned (Premiere clamps any clip that
    // would land before 0). Fall back to the clamped offset if TickTime rejects negatives.
    var offTick;
    try { offTick = ppro.TickTime.createWithSeconds(timeOffset); } catch (e) { offTick = TT(timeOffset); }
    await project.lockedAccess(function () {
      project.executeTransaction(function (action) {
        for (var t = 0; t < targets.length; t++) {
          try {
            action.addAction(ed.createCloneTrackItemAction(targets[t].item, offTick, targets[t].vIdx, targets[t].aIdx, targets[t].align, false));
            done++;
          } catch (e) { logLine('  ✗ clone lỗi: ' + (e.message || e), 'err'); }
        }
      }, 'Un-nest: clone ' + targets.length + ' clip');
    });

    // ── Clamp overflow: trim every NEW clone to at most UNNEST_PAD seconds beyond the
    //    nested region [winStart, winEnd]. Head never goes before timeline 0. ──
    var Hlo = Math.max(winStart - UNNEST_PAD, 0);
    var Hhi = winEnd + UNNEST_PAD;
    var trims = [];   // { item, doHead, doTail }
    var cntV = pv, cntA = pa;
    try { cntV = await un(parentSeq.getVideoTrackCount()); } catch (e) {}
    try { cntA = await un(parentSeq.getAudioTrackCount()); } catch (e) {}
    async function _collectNew(idx, isVideo) {
      var trk = await un(isVideo ? parentSeq.getVideoTrack(idx) : parentSeq.getAudioTrack(idx));
      if (!trk) return;
      var before = isVideo ? beforeV[idx] : beforeA[idx];
      var clips = await getClipItems(trk);
      for (var i = 0; i < clips.length; i++) {
        var key = await _clipKey(clips[i]);
        if (before && before[key]) continue; // pre-existing clip → leave it
        var cS = await callSec(clips[i], 'getStartTime'), cE = await callSec(clips[i], 'getEndTime');
        if (cS == null || cE == null) continue;
        var doHead = cS < Hlo - EPS, doTail = cE > Hhi + EPS;
        if (doHead || doTail) trims.push({ item: clips[i], doHead: doHead, doTail: doTail });
      }
    }
    for (var vv = 0; vv < cntV; vv++) await _collectNew(vv, true);
    for (var aa = 0; aa < cntA; aa++) await _collectNew(aa, false);

    if (trims.length) {
      await project.lockedAccess(function () {
        project.executeTransaction(function (action) {
          for (var q = 0; q < trims.length; q++) {
            var t = trims[q];
            try {
              // Trim the overflowing timeline edge(s) — createSetEndAction / createSetStartAction
              // move the clip's end/start (and adjust its source point) without shifting the rest.
              if (t.doTail && typeof t.item.createSetEndAction === 'function') action.addAction(t.item.createSetEndAction(TT(Hhi)));
              if (t.doHead && typeof t.item.createSetStartAction === 'function') action.addAction(t.item.createSetStartAction(TT(Hlo)));
            } catch (e) { logLine('  ✗ trim lỗi: ' + (e.message || e), 'err'); }
          }
        }, 'Un-nest: trim overflow ' + trims.length + ' clip');
      });
      logLine('✂ trim tràn: ' + trims.length + ' clip (±' + UNNEST_PAD + 's)', 'ok');
    }

    logLine('✓ "' + d.name + '": clone ' + done + ' clip (giữ effect) · video: dùng lại ' + reusedV + ' track trống + ' + (newV - pv) + ' track mới'
      + ((mode === 'av' || mode === 'avt') ? ' · audio: ' + reusedA + ' trống + ' + (newA - pa) + ' mới' : '')
      + ((mode === 'video' || mode === 'av') && vfDropped ? ' · bỏ ' + vfDropped + ' text/title' : ''), 'ok');
    return done;
  }

  // ── RUN ─────────────────────────────────────────────────────────────────────
  async function run() {
    if (busy) return;
    // Self-detect the current selection (no live list UI anymore). detect()
    // manages its own busy flag, so call it BEFORE we take busy here.
    await detect({ silent: true });
    if (!detected.length) {
      clearLog();
      logLine('Không tìm thấy nested sequence trong vùng chọn. Chọn 1 clip nested rồi chạy lại.', 'warn');
      return;
    }
    busy = true;
    setRunEnabled(false);
    clearLog();
    var mode = getMode();                       // 'video' | 'av' | 'avt'
    var disableOrig = !!els.disableOrig.checked;
    var totalPlaced = 0;
    var MODE_LABEL = { video: 'chỉ video (bỏ text)', av: 'video + audio', avt: 'video + audio + text' };

    // Snapshot the originals NOW — we're about to switch sequences around.
    var origItems = rawSelected.slice();

    try {
      var project = await getActiveProject();
      var parentSeq = await getActiveSequence();   // the sequence holding the nested clips

      logLine('Un-nest (API clone, giữ effect) · build: clone1 · ' + detected.length
        + ' clip · chế độ: ' + (MODE_LABEL[mode] || mode));

      for (var i = 0; i < detected.length; i++) {
        try {
          totalPlaced += await expandViaClone(project, parentSeq, detected[i], mode);
        } catch (e) {
          logLine('✗ "' + detected[i].name + '": ' + (e.message || e), 'err');
        }
      }

      // Disable the original nested clip(s) so playback isn't doubled
      if (disableOrig && origItems.length) {
        await openAndActivate(project, parentSeq);
        await sleep(SETTLE_SHORT);
        var disabledCount = 0;
        for (var k = 0; k < origItems.length; k++) {
          var it = origItems[k];
          if (it && typeof it.createSetDisabledAction === 'function') {
            try {
              await (function(node) {
                return project.lockedAccess(function() {
                  project.executeTransaction(function(action) {
                    action.addAction(node.createSetDisabledAction(true));
                  }, 'Un-nest: disable original');
                });
              })(it);
              disabledCount++;
            } catch (e) {}
          }
        }
        if (disabledCount) logLine('✓ đã tắt ' + disabledCount + ' clip nested gốc', 'ok');
      }

      logLine('—');
      logLine('HOÀN TẤT · tổng ' + totalPlaced + ' clip đã copy-paste. Kiểm tra timeline & Cmd+Z nếu cần.', 'ok');
    } catch (e) {
      logLine('✗ LỖI: ' + (e.message || e), 'err');
      console.error('[Un-nest] run error:', e);
    } finally {
      busy = false;
      setRunEnabled(detected.length > 0);
    }
  }

  // ── Clip-type classification for "video-only" mode ─────────────────────────
  // Goal: drop ONLY pure-text subtitle layers, keep everything with real visuals —
  // including graphics that also carry text (e.g. a badge = Text + Shape).
  // Confirmed component signatures on this build (probe v4):
  //   pure-text sub → Opacity, Motion, Graphic Group, Text            (Text, no Shape)
  //   visual badge  → Opacity, Motion, Graphic Group, Text, Shape     (Text + Shape → KEEP)
  //   footage       → Opacity, Motion, Ultra Key                      (no Text)
  //   text mogrt    → Capsule with typography params (Main Text/Font size/…)
  //   visual mogrt  → Capsule with Transform/Color params only (no text)
  var UNNEST_TEXT_COMP_RE   = /text|title|caption/i;                 // component = text
  var UNNEST_VISUAL_COMP_RE = /shape|image|media|solid|vector|ellipse|rectangle|footage|video/i; // component = real visual
  var UNNEST_TEXT_PARAM_RE  = /\btext\b|main text|source text|font\s?size|\bfont\b|tracking|leading|paragraph|highlight text|text box/i; // Capsule typography param

  // Classify a video-track clip. Returns { keep, reason }.
  // DROP only when the clip has text content AND no real visual component
  // (a pure subtitle). Footage, nested, AE comps, and text+visual graphics are kept.
  async function classifyVideoClip(clip) {
    try {
      var pi = await un(clip.getProjectItem ? clip.getProjectItem() : null);
      if (pi) { var cp = asClipPI(pi); if (cp) { try { if (await un(cp.isSequence())) return { keep: true, reason: '' }; } catch (e) {} } }

      var chain = clip.getComponentChain ? await un(clip.getComponentChain()) : null;
      if (!chain) return { keep: true, reason: '' };
      var cc = chain.getComponentCount ? await un(chain.getComponentCount()) : 0;
      var hasText = false, hasVisual = false, textSig = '';
      for (var k = 0; k < cc; k++) {
        var comp = await un(chain.getComponentAtIndex(k));
        if (!comp) continue;
        var cmn = ''; try { cmn = comp.getMatchName ? await un(comp.getMatchName()) : ''; } catch (e) {}
        if (cmn && UNNEST_VISUAL_COMP_RE.test(cmn)) { hasVisual = true; continue; }
        if (cmn && UNNEST_TEXT_COMP_RE.test(cmn)) { hasText = true; if (!textSig) textSig = 'comp:' + cmn; continue; }
        // Capsule (mogrt / Essential-Graphics container): inspect params for text.
        if (cmn && /capsule/i.test(cmn)) {
          var pc = comp.getParamCount ? await un(comp.getParamCount()) : 0;
          for (var pj = 0; pj < pc; pj++) {
            try {
              var prm = await un(comp.getParam(pj));
              var dn = '';
              if (prm) {
                if (typeof prm.getDisplayName === 'function') { dn = await un(prm.getDisplayName()); }
                else if (prm.displayName) { dn = prm.displayName; }
              }
              if (dn && UNNEST_TEXT_PARAM_RE.test(dn)) { hasText = true; if (!textSig) textSig = 'param:' + dn; }
            } catch (e) {}
          }
        }
      }
      // Pure text (text present, no visual component) → drop; otherwise keep.
      if (hasText && !hasVisual) return { keep: false, reason: textSig || 'text-only' };
      return { keep: true, reason: '' };
    } catch (e) { return { keep: true, reason: '' }; } // unknown → don't silently drop
  }

  // ── global hotkey trigger: poll the bridge, run on the current selection ────
  // The Swift app registers OS-global hotkeys and POSTs /unnest/trigger; we poll
  // and run — works regardless of which tab/panel is active.
  async function runMode(mode) {
    var r = document.querySelector('input[name="unMode"][value="' + mode + '"]');
    if (r) r.checked = true;
    await run();
  }
  // Host Premiere major version ('25'/'26') so the bridge can route a hotkey trigger
  // to the FOCUSED Premiere when 2025 and 2026 are open at once (both instances poll
  // the same bridge; without this the first poller wins regardless of focus).
  var HOST_VER = '';
  try {
    var _uh = window.require && window.require('uxp');
    if (_uh && _uh.host && _uh.host.version) HOST_VER = String(_uh.host.version).split('.')[0];
  } catch (e) {}
  var trigPolling = false;
  async function pollTrigger() {
    if (busy || trigPolling) return;
    trigPolling = true;
    try {
      var res = await fetch(BRIDGE_URL + '/unnest/poll?host=' + encodeURIComponent(HOST_VER));
      var j = await res.json();
      if (j && j.pending && j.pending.mode) await runMode(j.pending.mode);
    } catch (e) {} finally { trigPolling = false; }
  }
  setInterval(pollTrigger, 400);

  // ── hotkey config (click-to-capture, like Premiere's shortcut editor) ───────
  var HK_IDS = { video: 'unHkVideo', av: 'unHkAv', avt: 'unHkAvt' };
  var hotkeysCfg = null;
  function comboLabel(c) {
    if (!c || !c.code) return '—';
    return (c.ctrl ? '⌃' : '') + (c.opt ? '⌥' : '') + (c.shift ? '⇧' : '') + (c.cmd ? '⌘' : '')
      + String(c.code).replace(/^Key/, '').replace(/^Digit/, '');
  }

  // ── Premiere-shortcut conflict detection ────────────────────────────────────
  // The bridge parses the active (or default) .kys keymap; we compare each bound
  // combo against it and flag collisions with a ⚠ badge + hover tooltip.
  var premiereShortcuts = null; // { source: 'custom'|'default'|'none', list: [...] }
  var PUNCT_CODE = {
    Minus: '-', Equal: '=', Slash: '/', Backslash: '\\', Backquote: '`',
    Comma: ',', Period: '.', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  };
  function codeToChar(code) {
    if (!code) return '';
    var m = /^Key([A-Z])$/.exec(code); if (m) return m[1];
    m = /^Digit([0-9])$/.exec(code);   if (m) return m[1];
    return PUNCT_CODE[code] || '';
  }
  var CMD_NAMES = {
    'cmd.tools.01pointer': 'Selection Tool', 'cmd.tools.02trackselectforward': 'Track Select Forward',
    'cmd.tools.03ripple': 'Ripple Edit Tool', 'cmd.tools.04roll': 'Rolling Edit Tool',
    'cmd.tools.05ratestretch': 'Rate Stretch Tool', 'cmd.tools.06razor': 'Razor Tool',
    'cmd.tools.07slip': 'Slip Tool', 'cmd.tools.08slide': 'Slide Tool',
    'cmd.tools.09pen': 'Pen Tool', 'cmd.tools.10hand': 'Hand Tool',
    'cmd.tools.11zoom': 'Zoom Tool', 'cmd.tools.12text': 'Type Tool',
    'cmd.set.marker': 'Add Marker', 'cmd.edit.rippledelete': 'Ripple Delete',
    'cmd.sequence.razorateditline': 'Razor at Playhead',
  };
  function prettyCmd(cn) {
    if (CMD_NAMES[cn]) return CMD_NAMES[cn];
    var seg = String(cn || '').replace(/^cmd\./, '').split('.').pop() || cn;
    seg = seg.replace(/^\d+/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    if (!seg) return cn;
    return seg.charAt(0).toUpperCase() + seg.slice(1);
  }
  async function loadPremiereShortcuts() {
    try {
      var res = await fetch(BRIDGE_URL + '/unnest/premiere-shortcuts');
      var j = await res.json();
      premiereShortcuts = { source: (j && j.source) || 'none', list: (j && j.shortcuts) || [] };
    } catch (e) { premiereShortcuts = premiereShortcuts || { source: 'none', list: [] }; }
  }
  function conflictsFor(cfg) {
    if (!cfg || !cfg.code || !premiereShortcuts) return [];
    var ch = codeToChar(cfg.code);
    if (!ch) return [];
    return premiereShortcuts.list.filter(function (s) {
      return s.char === ch && !!s.cmd === !!cfg.cmd && !!s.opt === !!cfg.opt
        && !!s.shift === !!cfg.shift && !!s.ctrl === !!cfg.ctrl;
    });
  }
  var _curTip = null;
  function hideTip() { if (_curTip && _curTip.parentNode) _curTip.parentNode.removeChild(_curTip); _curTip = null; }
  function showTip(badge) {
    hideTip();
    var hits = badge._hits;
    if (!hits || !hits.length) return;
    var names = [];
    hits.forEach(function (h) { var n = prettyCmd(h.commandname); if (names.indexOf(n) === -1) names.push(n); });
    var srcTag = premiereShortcuts && premiereShortcuts.source === 'default' ? ' (mặc định)' : '';
    var tip = document.createElement('div');
    tip.className = 'un-hkTip';
    tip.innerHTML = '<b>⚠ Trùng shortcut Premiere' + srcTag + '</b>'
      + names.slice(0, 6).map(function (n) { return '<span class="un-tipCmd">• ' + escapeHtml(n) + '</span>'; }).join('')
      + (names.length > 6 ? '<span class="un-tipCmd">…+' + (names.length - 6) + ' lệnh khác</span>' : '');
    document.body.appendChild(tip);
    var r = badge.getBoundingClientRect();
    var maxW = (document.body && document.body.clientWidth) || 380;
    var left = Math.max(6, Math.min(r.left, maxW - 230));
    tip.style.left = left + 'px';
    tip.style.top = (r.bottom + 5) + 'px';
    _curTip = tip;
  }
  function refreshWarnings() {
    document.querySelectorAll('.un-hkWarn').forEach(function (w) {
      var mode = w.getAttribute('data-mode');
      var hits = conflictsFor(hotkeysCfg && hotkeysCfg[mode]);
      w._hits = hits.length ? hits : null;
      w.hidden = !hits.length;
    });
  }
  async function loadHotkeys() {
    try {
      var res = await fetch(BRIDGE_URL + '/unnest/hotkeys');
      var j = await res.json();
      hotkeysCfg = (j && j.hotkeys) || {};
    } catch (e) { hotkeysCfg = hotkeysCfg || {}; }
    for (var mode in HK_IDS) {
      if (!HK_IDS.hasOwnProperty(mode)) continue;
      var el = $(HK_IDS[mode]);
      if (el && hotkeysCfg[mode]) el.textContent = comboLabel(hotkeysCfg[mode]);
    }
    await loadPremiereShortcuts();
    refreshWarnings();
  }
  async function saveHotkey(mode, cfg) {
    hotkeysCfg = hotkeysCfg || {};
    hotkeysCfg[mode] = cfg;
    refreshWarnings();
    // Cleared (no code) → no duplicate check (many can be "off" at once).
    if (cfg && cfg.code) {
      var dupe = Object.keys(hotkeysCfg).filter(function (m) {
        return m !== mode && hotkeysCfg[m] && hotkeysCfg[m].code && comboLabel(hotkeysCfg[m]) === comboLabel(cfg);
      });
      if (dupe.length) logLine('⚠ Phím tắt trùng với: ' + dupe.join(', '), 'warn');
    }
    try {
      await fetch(BRIDGE_URL + '/unnest/hotkeys', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotkeys: hotkeysCfg }),
      });
    } catch (e) { logLine('Lưu phím tắt lỗi: ' + (e.message || e), 'err'); }
  }
  // Double-click a shortcut chip → capture a new combo. textEl holds the label
  // text; containerEl (the chip) gets the listening highlight and holds the ✕.
  function captureCombo(textEl, containerEl, mode) {
    var prev = textEl.textContent;
    textEl.textContent = 'Bấm tổ hợp…';
    containerEl.classList.add('is-listening');
    // UXP (Premiere 25+) only delivers keydown to a FOCUSED focusable element — a
    // document listener on a <span> never fires and Premiere handles the key itself.
    // So we overlay a transparent, focusable <input>, focus it, and listen on IT
    // (same pattern as the Autocut bind modal: focus input + claimKeyboard).
    var trap = document.createElement('input');
    trap.type = 'text';
    trap.className = 'un-hkTrap';
    trap.setAttribute('aria-hidden', 'true');
    containerEl.appendChild(trap);
    var done = false;
    function cleanup() {
      if (done) return; done = true;
      containerEl.classList.remove('is-listening');
      trap.removeEventListener('keydown', onKey, true);
      trap.removeEventListener('blur', onBlur);
      if (trap.parentNode) trap.parentNode.removeChild(trap);
      if (window.releaseKeyboard) window.releaseKeyboard();
    }
    function onBlur() { if (done) return; textEl.textContent = prev; cleanup(); } // clicked away → cancel
    function onKey(e) {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { textEl.textContent = prev; cleanup(); return; }
      if (['Meta', 'Alt', 'Control', 'Shift', 'CapsLock'].indexOf(e.key) !== -1) return; // wait for a real key
      var cfg = { code: e.code, cmd: !!e.metaKey, opt: !!e.altKey, ctrl: !!e.ctrlKey, shift: !!e.shiftKey };
      // Require ⌘/⌥/⌃ (shift alone still types a character): a bare key would hijack
      // typing in Premiere (rename fields, Essential Graphics text) which we can't
      // detect reliably. Modifier combos never clash with text entry.
      if (!(cfg.cmd || cfg.opt || cfg.ctrl)) { textEl.textContent = 'Cần ⌘/⌥/⌃ + phím…'; return; }
      textEl.textContent = comboLabel(cfg);
      cleanup();
      saveHotkey(mode, cfg);
    }
    trap.addEventListener('keydown', onKey, true);
    trap.addEventListener('blur', onBlur);
    try { trap.focus(); } catch (e) {}
    if (window.claimKeyboard) window.claimKeyboard();
  }

  // ── wire events ─────────────────────────────────────────────────────────────
  // No live selection list anymore (Un-nest lives in Settings). run() self-detects
  // the current selection, and the optional Quét-lại button just previews it.
  if (els.refresh) els.refresh.addEventListener('click', function() { detect(); });
  els.run.addEventListener('click', run);
  // Double-click the chip → re-assign; the small ✕ (shown on hover) → clear.
  document.querySelectorAll('.un-hkLabel').forEach(function (lbl) {
    lbl.addEventListener('dblclick', function () {
      var mode = lbl.getAttribute('data-mode');
      var textEl = $(HK_IDS[mode]);
      if (textEl) captureCombo(textEl, lbl, mode);
    });
  });
  document.querySelectorAll('.un-hkX').forEach(function (x) {
    x.addEventListener('click', function (e) {
      e.stopPropagation(); // don't trigger the chip's dblclick capture
      var mode = x.getAttribute('data-mode');
      var textEl = $(HK_IDS[mode]);
      if (textEl) textEl.textContent = '—';
      saveHotkey(mode, { code: '', cmd: false, opt: false, ctrl: false, shift: false });
    });
  });
  // Conflict-warning badge: hover shows a custom tooltip (UXP has no title="").
  document.querySelectorAll('.un-hkWarn').forEach(function (w) {
    w.addEventListener('mouseenter', function () { showTip(w); });
    w.addEventListener('mouseleave', hideTip);
  });
  loadHotkeys(); // populate labels + premiere-shortcut conflicts (defaults if unreachable)
  document.querySelectorAll('.settings-tab').forEach(function (t) {
    if (t.getAttribute('data-stab') === 'unnest') t.addEventListener('click', loadHotkeys);
  });
})();
