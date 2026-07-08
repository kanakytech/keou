/* ═══════════════════════════════════════════
   KEOU AGENCY — Lightbox 3.0
   Enriched preview: metadata bar, action buttons,
   creative direction for video, keyboard shortcuts
   Used across: Studio, History, Dashboard, Projects
   ═══════════════════════════════════════════ */

const Lightbox = (() => {
  let _el = null;
  let _overlay = null;
  let _body = null;
  let _toolbar = null;
  let _metaBar = null;
  let _actionBar = null;
  let _cdWrap = null;
  let _built = false;
  let _currentUrl = '';
  let _currentMeta = null;
  let _previousFocus = null; // a11y: focus to restore on close
  let _vtBusy = false; // re-entrance guard for the thumbnail→lightbox morph
  // API cache (60s TTL) — avoid refetching on every lightbox open
  let _projectsCache = null;
  let _projectsCacheAt = 0;
  let _campaignsCache = {};  // keyed by projectId
  let _campaignsCacheAt = {};
  const _CACHE_TTL = 60_000;

  function _build() {
    if (_built) return;
    _built = true;

    const style = document.createElement('style');
    style.textContent = `
      .lightbox{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;opacity:0;visibility:hidden;transition:opacity .25s ease,visibility .25s ease}
      .lightbox.open{opacity:1;visibility:visible}
      .lightbox-overlay{position:absolute;inset:0;background:rgba(0,0,0,.78);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);cursor:pointer}
      .lightbox-content{position:relative;z-index:2;display:flex;align-items:center;justify-content:center;transform:scale(.92);transition:transform .3s cubic-bezier(.16,1,.3,1);pointer-events:none}
      .lightbox.open .lightbox-content{transform:scale(1)}
      ::view-transition-group(lb-morph){animation-duration:.38s;animation-timing-function:cubic-bezier(.16,1,.3,1)}
      ::view-transition-old(lb-morph),::view-transition-new(lb-morph){height:100%;object-fit:contain}
      .lightbox-content img,.lightbox-content video{
        max-width:min(90vw,1200px);max-height:72vh;display:block;
        border-radius:12px;box-shadow:0 32px 80px rgba(0,0,0,.35);
        pointer-events:auto;user-select:none;
        transition:transform .35s cubic-bezier(.16,1,.3,1),max-width .35s cubic-bezier(.16,1,.3,1),max-height .35s cubic-bezier(.16,1,.3,1);
        cursor:default;
      }
      .lightbox-audio{
        pointer-events:auto;display:flex;flex-direction:column;align-items:center;gap:20px;
        padding:40px 48px;border-radius:20px;
        background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);
        backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
        box-shadow:0 32px 80px rgba(0,0,0,.35);min-width:340px;max-width:min(90vw,500px);
      }
      .lightbox-audio .la-icon{color:rgba(255,255,255,.5)}
      .lightbox-audio .la-title{font-size:14px;font-weight:700;color:#fff;letter-spacing:.2px}
      .lightbox-audio audio{width:100%;border-radius:8px}
      .lightbox-toolbar{
        position:fixed;top:20px;right:20px;z-index:10000;
        display:flex;gap:8px;opacity:0;transform:translateY(-8px);
        transition:all .25s ease;
      }
      .lightbox.open .lightbox-toolbar{opacity:1;transform:translateY(0);transition-delay:.15s}
      .lightbox-btn{
        width:40px;height:40px;border-radius:50%;
        background:rgba(255,255,255,.12);border:1.5px solid rgba(255,255,255,.2);
        color:#fff;font-size:20px;cursor:pointer;
        display:flex;align-items:center;justify-content:center;
        backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
        transition:all .2s ease;
      }
      .lightbox-btn:hover{background:rgba(255,255,255,.25);transform:scale(1.08)}
      .lightbox-btn svg{width:18px;height:18px}

      /* ═══ BOTTOM BAR — stacked layout, never overlaps ═══
         Layer 1 (bottom):  Meta bar — info pills
         Layer 2:           Action buttons
         Layer 3:           Side panels (ref image left, CD display right)
         Layer 4 (top):     Input panels (CD, Remix, Move)
      */

      /* ── L1: Metadata Bar ── */
      .lb-meta{
        position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(8px);z-index:10000;
        display:flex;align-items:center;gap:0;padding:0;
        background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.15);
        border-radius:100px;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
        opacity:0;transition:all .3s ease;pointer-events:auto;white-space:nowrap;
        max-width:calc(100vw - 40px);
      }
      .lightbox.open .lb-meta{opacity:1;transform:translateX(-50%) translateY(0);transition-delay:.2s}
      .lb-meta-pill{padding:8px 16px;font-size:11px;font-weight:600;color:rgba(255,255,255,.85);letter-spacing:.3px}
      .lb-meta-sep{width:1px;height:16px;background:rgba(255,255,255,.2);flex-shrink:0}

      /* ── L2: Action Buttons ── */
      .lb-actions{
        position:fixed;bottom:68px;left:50%;transform:translateX(-50%) translateY(8px);z-index:10000;
        display:flex;gap:8px;opacity:0;transition:all .3s ease;
      }
      .lightbox.open .lb-actions{opacity:1;transform:translateX(-50%) translateY(0);transition-delay:.25s}
      .lb-action-btn{
        padding:10px 20px;border-radius:100px;border:1.5px solid rgba(255,255,255,.2);
        background:rgba(255,255,255,.10);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
        color:#fff;font-size:12px;font-weight:600;cursor:pointer;
        display:inline-flex;align-items:center;gap:6px;
        font-family:'Inter',sans-serif;transition:all .2s ease;letter-spacing:.2px;
      }
      .lb-action-btn:hover{background:rgba(255,255,255,.22);transform:translateY(-1px)}
      .lb-action-btn svg{width:14px;height:14px}

      /* ── L4: Creative Direction Input Panel ── */
      .lb-cd{
        position:fixed;bottom:116px;left:50%;transform:translateX(-50%);z-index:10001;
        width:min(420px,90vw);display:none;flex-direction:column;gap:10px;
        background:rgba(20,20,20,.92);border:1px solid rgba(255,255,255,.12);
        border-radius:16px;padding:16px;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
      }
      .lb-cd.visible{display:flex}

      /* ── Model Selector ── */
      .lb-model-label{font-size:10px;font-weight:600;color:rgba(255,255,255,.45);text-transform:uppercase;letter-spacing:.8px}
      .lb-model-chips{display:flex;gap:6px;flex-wrap:wrap}
      .lb-model-chip{
        padding:7px 14px;border-radius:100px;border:1.5px solid rgba(255,255,255,.15);
        background:transparent;color:rgba(255,255,255,.65);font-size:11px;font-weight:600;
        cursor:pointer;font-family:'Inter',sans-serif;transition:all .2s;
        display:inline-flex;align-items:center;gap:5px;
      }
      .lb-model-chip:hover{border-color:rgba(255,255,255,.35);color:#fff}
      .lb-model-chip.active{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.4);color:#fff}
      .lb-model-chip svg{width:12px;height:12px;opacity:.7}

      .lb-cd textarea{
        width:100%;box-sizing:border-box;border:1px solid rgba(255,255,255,.15);border-radius:10px;
        background:rgba(255,255,255,.06);color:#fff;padding:10px 14px;font-size:13px;
        font-family:'Inter',sans-serif;resize:vertical;min-height:56px;max-height:120px;
        outline:none;transition:border-color .2s;
      }
      .lb-cd textarea:focus{border-color:rgba(255,255,255,.35)}
      .lb-cd textarea::placeholder{color:rgba(255,255,255,.35)}
      .lb-cd-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .lb-cd-hint{font-size:10px;color:rgba(255,255,255,.4);font-style:italic}
      .lb-cd-submit{
        padding:8px 20px;border-radius:100px;border:none;
        background:#fff;color:#0a0a0a;font-size:12px;font-weight:700;
        cursor:pointer;font-family:'Inter',sans-serif;transition:all .2s;
      }
      .lb-cd-submit:hover{background:rgba(255,255,255,.85);transform:scale(1.03)}

      /* ── L4: Remix Panel ── */
      .lb-remix{
        position:fixed;bottom:116px;left:50%;transform:translateX(-50%);z-index:10001;
        width:min(420px,90vw);display:none;flex-direction:column;gap:10px;
        background:rgba(20,20,20,.92);border:1px solid rgba(255,255,255,.12);
        border-radius:16px;padding:16px;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
      }
      .lb-remix.visible{display:flex}
      .lb-remix textarea{
        width:100%;box-sizing:border-box;border:1px solid rgba(255,255,255,.15);border-radius:10px;
        background:rgba(255,255,255,.06);color:#fff;padding:10px 14px;font-size:13px;
        font-family:'Inter',sans-serif;resize:vertical;min-height:56px;max-height:120px;
        outline:none;transition:border-color .2s;
      }
      .lb-remix textarea:focus{border-color:rgba(255,255,255,.35)}
      .lb-remix textarea::placeholder{color:rgba(255,255,255,.35)}

      /* ── L4: Move to Campaign Panel ── */
      .lb-move{
        position:fixed;bottom:116px;left:50%;transform:translateX(-50%);z-index:10001;
        width:min(320px,90vw);display:none;flex-direction:column;gap:8px;
        background:rgba(20,20,20,.92);border:1px solid rgba(255,255,255,.12);
        border-radius:16px;padding:16px;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
      }
      .lb-move.visible{display:flex}
      .lb-move-title{font-size:10px;font-weight:600;color:rgba(255,255,255,.45);text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px}
      .lb-move-list{max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:4px}
      .lb-move-item{
        padding:10px 14px;border-radius:10px;
        background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);
        color:rgba(255,255,255,.85);font-size:12px;font-weight:500;cursor:pointer;
        transition:all .2s;font-family:'Inter',sans-serif;
        display:flex;align-items:center;gap:8px;
      }
      .lb-move-item:hover{background:rgba(255,255,255,.15);border-color:rgba(255,255,255,.25)}
      .lb-move-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
      .lb-move-loading{text-align:center;padding:12px;font-size:11px;color:rgba(255,255,255,.4)}

      @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}

      /* ── L3: Reference Image (left side of image) ── */
      .lb-ref{
        position:fixed;top:50%;left:20px;transform:translateY(-50%);z-index:10000;
        display:none;flex-direction:column;gap:6px;
        pointer-events:auto;opacity:0;
        transition:all .3s ease;
      }
      .lightbox.open .lb-ref{opacity:1;transition-delay:.25s}
      .lb-ref-label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:rgba(255,255,255,.4)}
      .lb-ref-thumb{
        width:72px;height:72px;border-radius:10px;overflow:hidden;
        border:1.5px solid rgba(255,255,255,.2);cursor:pointer;
        background:rgba(255,255,255,.08);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
        transition:all .35s cubic-bezier(.16,1,.3,1);
        box-shadow:0 8px 24px rgba(0,0,0,.3);
      }
      .lb-ref-thumb:hover{border-color:rgba(255,255,255,.4);transform:scale(1.06)}
      .lb-ref-thumb.expanded{
        width:min(280px,40vw);height:auto;max-height:50vh;
        border-radius:14px;
      }
      .lb-ref-thumb img{
        width:100%;height:100%;object-fit:cover;display:block;
        transition:all .35s cubic-bezier(.16,1,.3,1);
      }
      .lb-ref-thumb.expanded img{
        height:auto;object-fit:contain;
      }

      /* ── L3: Creative Direction Display (right side of image) ── */
      .lb-cd-display{
        position:fixed;top:50%;right:20px;transform:translateY(-50%);z-index:10000;
        max-width:200px;padding:10px 16px;
        background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.15);
        border-radius:14px;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
        opacity:0;transition:all .3s ease;
        pointer-events:auto;
      }
      .lightbox.open .lb-cd-display{opacity:1;transition-delay:.25s}
      .lb-cd-label{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:rgba(255,255,255,.4);margin-bottom:4px}
      .lb-cd-text{font-size:11px;font-weight:500;color:rgba(255,255,255,.85);line-height:1.4;word-break:break-word}

      /* ═══ TABLET ═══ */
      @media(max-width:768px){
        .lightbox{overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0}
        .lightbox-content{margin:0;width:100%;display:flex;justify-content:center;align-items:center;flex:1}
        .lightbox-content img,.lightbox-content video{max-width:88vw;max-height:60vh;border-radius:10px;object-fit:contain}
        .lightbox-toolbar{top:10px;right:10px;gap:6px;z-index:10}
        .lightbox-btn{width:40px;height:40px}

        .lightbox-overlay{background:rgba(0,0,0,.97)}

        /* Meta bar — centered top */
        .lb-meta{border-radius:10px;flex-wrap:wrap;max-width:90vw;bottom:auto;top:10px;left:50%;transform:translateX(-50%);gap:0;padding:2px 4px}
        .lightbox.open .lb-meta{transform:translateX(-50%) translateY(0)}
        .lb-meta-pill{padding:4px 8px;font-size:9px}
        .lb-meta-sep{height:10px}

        /* Actions — fixed bottom pill, respects safe-area for iPhone */
        .lb-actions{
          position:fixed!important;
          bottom:calc(16px + env(safe-area-inset-bottom,0));
          left:50%;transform:translateX(-50%)!important;
          display:flex!important;flex-wrap:nowrap;gap:6px;
          max-width:94vw;width:auto;margin:0;padding:8px 14px;
          opacity:1;overflow-x:auto;-webkit-overflow-scrolling:touch;
          background:rgba(0,0,0,.75);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
          border-radius:100px;border:1px solid rgba(255,255,255,.1);
        }
        .lb-actions::-webkit-scrollbar{display:none}
        .lightbox.open .lb-actions{transform:translateX(-50%)!important;transition-delay:0s}
        .lb-action-btn{
          padding:11px 16px;font-size:11px;gap:5px;border-radius:100px;
          white-space:nowrap;flex-shrink:0;min-height:44px;border:none;
          background:rgba(255,255,255,.12);
        }
        .lb-action-btn:active{background:rgba(255,255,255,.22);transform:scale(.96)}
        .lb-action-btn svg{width:14px;height:14px}

        /* Input panels — fixed bottom, account for action bar height + safe-area */
        .lb-cd,.lb-remix,.lb-move{
          bottom:calc(80px + env(safe-area-inset-bottom,0));
          position:fixed;width:90vw;left:5vw;transform:none;margin:0;
        }
        .lb-model-chips{gap:5px}
        .lb-model-chip{padding:8px 12px;font-size:11px;min-height:38px}
        .lb-cd textarea{min-height:48px;font-size:14px}
        .lb-cd-submit{padding:10px 24px;font-size:13px;min-height:44px}

        /* CD Display — top right below toolbar */
        .lb-cd-display{
          top:54px;right:10px;transform:none;
          max-width:min(160px,40vw);border-radius:10px;
          padding:6px 10px;
        }
        .lb-cd-label{font-size:8px}
        .lb-cd-text{font-size:10px}

        /* Reference — top left below meta */
        .lb-ref{top:48px;left:10px;transform:none}
        .lb-ref-thumb{width:50px;height:50px;border-radius:8px}
        .lb-ref-thumb.expanded{width:min(180px,38vw);border-radius:10px}
      }

      /* ═══ SMALL MOBILE ═══ */
      @media(max-width:480px){
        .lightbox-content img,.lightbox-content video{max-width:94vw;max-height:55vh}
        .lightbox-btn{width:36px;height:36px}
        .lightbox-btn svg{width:15px;height:15px}
        .lb-meta{max-width:92vw}
        .lb-meta-pill{padding:3px 6px;font-size:8px}
        /* keep min-height 44px on small phones for WCAG touch target */
        .lb-action-btn{padding:11px 14px;font-size:10px;gap:4px;min-height:44px}
        .lb-action-btn svg{width:12px;height:12px}
        .lb-cd{width:92vw;left:4vw}
        .lb-remix{width:92vw;left:4vw}
        .lb-move{width:92vw;left:4vw}
        .lb-model-chip{padding:7px 10px;font-size:10px}
        .lb-ref-thumb{width:40px;height:40px}
        .lb-ref-thumb.expanded{width:min(140px,36vw)}
      }
    `;
    document.head.appendChild(style);

    _el = document.createElement('div');
    _el.className = 'lightbox';
    _el.setAttribute('role', 'dialog');
    _el.setAttribute('aria-modal', 'true');
    _el.setAttribute('aria-label', 'Asset preview');
    _el.setAttribute('aria-hidden', 'true');
    _el.innerHTML = `
      <div class="lightbox-overlay"></div>
      <div class="lightbox-content"></div>
      <div class="lightbox-toolbar">
        <button class="lightbox-btn lb-dl" aria-label="Download" title="Download (D)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
        <button class="lightbox-btn lb-close" aria-label="Close" title="Close (Esc)">&times;</button>
      </div>
      <div class="lb-actions" id="lb-actions"></div>
      <div class="lb-meta" id="lb-meta"></div>
      <div class="lb-cd" id="lb-cd">
        <span class="lb-model-label">Model</span>
        <div class="lb-model-chips" id="lb-model-chips">
          <button class="lb-model-chip active" data-model="grok-imagine">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            Grok Imagine
          </button>
          <button class="lb-model-chip" data-model="kling-2.6">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
            Kling 2.6
          </button>
          <button class="lb-model-chip" data-model="kling-3.0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/><line x1="17" y1="17" x2="22" y2="17"/></svg>
            Kling 3.0
          </button>
          <button class="lb-model-chip" data-model="seedance-2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>
            Seedance 2.0
          </button>
          <button class="lb-model-chip" data-model="veo3">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
            Veo 3.1
          </button>
        </div>
        <textarea id="lb-cd-input" placeholder="Describe your video vision... e.g. Slow luxury push-in, warm golden light, premium feel"></textarea>
        <span class="lb-model-label" style="margin-top:10px">Duration</span>
        <div class="lb-model-chips" id="lb-duration-chips">
          <button class="lb-model-chip" data-duration="5">5s</button>
          <button class="lb-model-chip active" data-duration="10">10s</button>
          <button class="lb-model-chip" data-duration="15">15s</button>
        </div>
        <div class="lb-cd-row">
          <span class="lb-cd-hint">Optional — leave empty for default cinematic style</span>
          <button class="lb-cd-submit" id="lb-cd-go">Generate Video</button>
        </div>
      </div>
      <div class="lb-remix" id="lb-remix">
        <textarea id="lb-remix-input" placeholder="What to change... e.g. warmer lighting, remove shadow, add beach background"></textarea>
        <div class="lb-cd-row">
          <span class="lb-cd-hint">Describe the modification</span>
          <button class="lb-cd-submit" id="lb-remix-go">Remix</button>
        </div>
      </div>
      <div class="lb-move" id="lb-move">
        <span class="lb-move-title" id="lb-move-title">Move to Campaign</span>
        <div class="lb-move-list" id="lb-move-list">
          <div class="lb-move-loading">Loading...</div>
        </div>
      </div>
      <div class="lb-ref" id="lb-ref">
        <span class="lb-ref-label">Reference</span>
        <div class="lb-ref-thumb" id="lb-ref-thumb">
          <img id="lb-ref-img" src="" alt="Reference image">
        </div>
      </div>
      <div class="lb-cd-display" id="lb-cd-display" style="display:none">
        <div class="lb-cd-label">Creative Direction</div>
        <div class="lb-cd-text" id="lb-cd-display-text"></div>
      </div>
    `;
    document.body.appendChild(_el);

    _overlay = _el.querySelector('.lightbox-overlay');
    _body = _el.querySelector('.lightbox-content');
    _toolbar = _el.querySelector('.lightbox-toolbar');
    _metaBar = _el.querySelector('#lb-meta');
    _actionBar = _el.querySelector('#lb-actions');
    _cdWrap = _el.querySelector('#lb-cd');

    _overlay.addEventListener('click', close);
    _el.querySelector('.lb-close').addEventListener('click', close);
    _el.querySelector('.lb-dl').addEventListener('click', _download);

    // Reference image toggle expand/collapse
    _el.querySelector('#lb-ref-thumb').addEventListener('click', () => {
      _el.querySelector('#lb-ref-thumb').classList.toggle('expanded');
    });

    // Model chip selection
    _el.querySelector('#lb-model-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.lb-model-chip');
      if (!chip) return;
      _el.querySelectorAll('#lb-model-chips .lb-model-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    });

    // Duration chip selection
    _el.querySelector('#lb-duration-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.lb-model-chip');
      if (!chip) return;
      _el.querySelectorAll('#lb-duration-chips .lb-model-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    });

    // Generate Video button in CD panel
    _el.querySelector('#lb-cd-go').addEventListener('click', () => {
      if (!_currentMeta?.onVideo) return;
      const cd = _el.querySelector('#lb-cd-input').value.trim();
      const activeModelChip = _el.querySelector('#lb-model-chips .lb-model-chip.active');
      const model = activeModelChip ? activeModelChip.dataset.model : 'grok-imagine';
      const activeDurationChip = _el.querySelector('#lb-duration-chips .lb-model-chip.active');
      const duration = activeDurationChip ? parseInt(activeDurationChip.dataset.duration) : 10;
      _cdWrap.classList.remove('visible');
      _currentMeta.onVideo(cd, model, duration);
      close();
    });

    // Remix submit button
    _el.querySelector('#lb-remix-go').addEventListener('click', () => {
      if (!_currentMeta?.onRemix) return;
      const prompt = _el.querySelector('#lb-remix-input').value.trim();
      if (!prompt) return;
      _el.querySelector('#lb-remix').classList.remove('visible');
      _currentMeta.onRemix(prompt);
      close();
    });

    // Focus trap — keep Tab navigation inside the dialog while it's open
    document.addEventListener('keydown', (e) => {
      if (!_el.classList.contains('open')) return;
      if (e.key !== 'Tab') return;
      const focusables = _el.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      const visible = Array.from(focusables).filter(el => el.offsetParent !== null);
      if (visible.length === 0) return;
      const first = visible[0];
      const last = visible[visible.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (!_el.classList.contains('open')) return;
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
      if (e.key === 'Escape') close();
      if (e.key === 'd' || e.key === 'D') _download();
      if ((e.key === 'a' || e.key === 'A') && _currentMeta?.onAdapt) {
        _currentMeta.onAdapt();
        close();
      }
      if ((e.key === 'r' || e.key === 'R') && _currentMeta?.onRemix) {
        _toggleRemix();
      }
      if ((e.key === 'p' || e.key === 'P') && _currentMeta?.onPolish) {
        _currentMeta.onPolish();
        close();
      }
      if ((e.key === 'v' || e.key === 'V') && _currentMeta?.onVideo) {
        _toggleCD();
      }
      if ((e.key === 'u' || e.key === 'U') && _currentMeta?.onUpscale) {
        _currentMeta.onUpscale();
        close();
      }
      if ((e.key === 'k' || e.key === 'K') && _currentMeta?.onPack) {
        _currentMeta.onPack();
        close();
      }
      if ((e.key === 'm' || e.key === 'M') && _currentMeta?.generationId) {
        _toggleMove();
      }
    });

  }

  function _toggleMove() {
    _cdWrap.classList.remove('visible');
    _el.querySelector('#lb-remix')?.classList.remove('visible');
    const movePanel = _el.querySelector('#lb-move');
    movePanel.classList.toggle('visible');
    if (movePanel.classList.contains('visible')) _loadProjects();
  }

  async function _loadProjects() {
    const list = _el.querySelector('#lb-move-list');
    const title = _el.querySelector('#lb-move-title');
    title.textContent = 'Select Client';
    list.innerHTML = '<div class="lb-move-loading">Loading...</div>';
    try {
      let projects;
      const now = Date.now();
      if (_projectsCache && now - _projectsCacheAt < _CACHE_TTL) {
        projects = _projectsCache;
      } else {
        const res = await (window.Auth?.authFetch || fetch)('/api/projects');
        const data = await res.json();
        projects = (data.projects || []).filter(p => p.status === 'active');
        _projectsCache = projects;
        _projectsCacheAt = now;
      }
      if (!projects.length) { list.innerHTML = '<div class="lb-move-loading">No clients found</div>'; return; }
      list.innerHTML = projects.map(p =>
        `<div class="lb-move-item" data-pid="${p.id}" data-pname="${p.name.replace(/"/g, '&quot;')}">
          <span class="lb-move-dot" style="background:${p.color || '#6B7280'}"></span>
          ${escapeHtml(p.name)}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;margin-left:auto;opacity:.4"><polyline points="9 18 15 12 9 6"/></svg>
        </div>`
      ).join('');
      list.querySelectorAll('.lb-move-item').forEach(item => {
        item.addEventListener('click', () => _loadCampaigns(parseInt(item.dataset.pid), item.dataset.pname));
      });
    } catch { list.innerHTML = '<div class="lb-move-loading">Failed to load</div>'; }
  }

  async function _loadCampaigns(projectId, projectName) {
    const list = _el.querySelector('#lb-move-list');
    const title = _el.querySelector('#lb-move-title');
    title.innerHTML = `<span style="cursor:pointer;opacity:.6" id="lb-move-back">&larr;</span> ${escapeHtml(projectName)}`;
    list.innerHTML = '<div class="lb-move-loading">Loading campaigns...</div>';

    // Back button to return to project list
    _el.querySelector('#lb-move-back')?.addEventListener('click', (e) => {
      e.stopPropagation();
      _loadProjects();
    });

    try {
      let campaigns;
      const now = Date.now();
      if (_campaignsCache[projectId] && now - (_campaignsCacheAt[projectId] || 0) < _CACHE_TTL) {
        campaigns = _campaignsCache[projectId];
      } else {
        const res = await (window.Auth?.authFetch || fetch)(`/api/campaigns?projectId=${projectId}`);
        const data = await res.json();
        campaigns = (data.campaigns || []).filter(c => c.status !== 'archived');
        _campaignsCache[projectId] = campaigns;
        _campaignsCacheAt[projectId] = now;
      }
      if (!campaigns.length) { list.innerHTML = '<div class="lb-move-loading">No campaigns found</div>'; return; }
      list.innerHTML = campaigns.map(c =>
        `<div class="lb-move-item" data-cid="${c.id}" data-cname="${(c.name || '').replace(/"/g, '&quot;')}">
          <span class="lb-move-dot" style="background:${c.color || '#06B6D4'}"></span>
          ${escapeHtml(c.name)}
        </div>`
      ).join('');
      list.querySelectorAll('.lb-move-item').forEach(item => {
        item.addEventListener('click', () => _assignCampaign(parseInt(item.dataset.cid), item.dataset.cname, projectName));
      });
    } catch { list.innerHTML = '<div class="lb-move-loading">Failed to load campaigns</div>'; }
  }

  async function _assignCampaign(campaignId, campaignName, projectName) {
    if (!_currentMeta?.generationId) return;
    try {
      const res = await (window.Auth?.authFetch || fetch)(`/api/campaigns/${campaignId}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generationId: _currentMeta.generationId }),
      });
      if (!res.ok) throw new Error('Failed');
      // Invalidate caches after move
      _projectsCache = null;
      _campaignsCache = {};
      window.toast?.(`Moved to ${projectName} / ${campaignName}`);
      _el.querySelector('#lb-move')?.classList.remove('visible');
    } catch { window.toast?.('Failed to move asset', true); }
  }

  function _toggleCD() {
    _el.querySelector('#lb-remix')?.classList.remove('visible');
    _el.querySelector('#lb-move')?.classList.remove('visible');
    _cdWrap.classList.toggle('visible');
    if (_cdWrap.classList.contains('visible')) {
      setTimeout(() => _el.querySelector('#lb-cd-input').focus(), 50);
    }
  }

  function _toggleRemix() {
    _cdWrap.classList.remove('visible');
    _el.querySelector('#lb-move')?.classList.remove('visible');
    const remixPanel = _el.querySelector('#lb-remix');
    remixPanel.classList.toggle('visible');
    if (remixPanel.classList.contains('visible')) {
      setTimeout(() => _el.querySelector('#lb-remix-input').focus(), 50);
    }
  }

  async function _download() {
    if (!_currentUrl) return;
    const dlBtn = _el.querySelector('.lb-dl');
    const originalHTML = dlBtn.innerHTML;

    // Show loading state
    dlBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px;animation:spin .8s linear infinite"><path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4m-3.93 7.07l-2.83-2.83M7.76 7.76L4.93 4.93"/></svg>';
    dlBtn.style.pointerEvents = 'none';
    window.toast?.('Preparing download...');

    const ext = _currentUrl.split('/').pop().split('?')[0].split('.').pop() || 'png';
    const isVideo = _body?.querySelector('video');
    const isAudio = _body?.querySelector('.lightbox-audio');
    const mediaType = isAudio ? 'audio' : isVideo ? 'video' : 'image';
    const fname = `keou-${mediaType}-${Date.now()}.${ext}`;
    try {
      const proxyUrl = `/api/download?url=${encodeURIComponent(_currentUrl)}&name=${encodeURIComponent(fname)}`;
      const res = await (window.Auth?.authFetch || fetch)(proxyUrl);
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
      window.toast?.('Download complete');
    } catch (e) {
      // Fallback: try direct fetch blob (no proxy)
      try {
        const directRes = await fetch(_currentUrl);
        if (!directRes.ok) throw new Error('Direct fetch failed');
        const blob = await directRes.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(blobUrl);
        window.toast?.('Download complete');
      } catch {
        // Last resort: force download via anchor (no new tab)
        const a = document.createElement('a');
        a.href = _currentUrl;
        a.download = fname;
        a.target = '_self';
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.toast?.('Download started');
      }
    } finally {
      dlBtn.innerHTML = originalHTML;
      dlBtn.style.pointerEvents = '';
    }
  }

  /**
   * Open lightbox.
   * @param {string} url
   * @param {'image'|'video'} type
   * @param {Object} [meta] - Optional metadata & callbacks
   * @param {string} [meta.genType] - 'image'|'video'|'polish'
   * @param {string} [meta.date] - formatted date
   * @param {string} [meta.format] - '1:1', '3:4', etc
   * @param {string} [meta.cost] - e.g. '$0.09'
   * @param {string} [meta.userName] - creator name
   * @param {string} [meta.creativeDirection] - user's creative direction text
   * @param {string} [meta.inputUrl] - original product image URL (for Adapt)
   * @param {Function} [meta.onAdapt] - callback for Adapt All Formats (A)
   * @param {Function} [meta.onRemix] - callback for Remix action (receives remixPrompt)
   * @param {Function} [meta.onPolish] - callback for Polish action
   * @param {Function} [meta.onVideo] - callback for Video action (receives creativeDirection string)
   * @param {Function} [meta.onUpscale] - callback for Upscale 4K action (video only)
   * @param {Function} [meta.onPack] - callback for Export Pack action (K)
   */
  function open(url, type = 'image', meta = null) {
    // Liquid morph: the clicked thumbnail grows into the lightbox via the
    // View Transitions API. Re-enters open() inside the snapshot callback;
    // _vtBusy makes the inner call take the normal path. Falls through
    // silently on browsers without VT or with reduced motion.
    if (type === 'image' && !_vtBusy && document.startViewTransition
        && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const thumb = Array.from(document.querySelectorAll('img')).find(
        i => (i.currentSrc === url || i.src === url) && i.checkVisibility && i.checkVisibility()
      );
      if (thumb) {
        _vtBusy = true;
        thumb.style.viewTransitionName = 'lb-morph';
        const vt = document.startViewTransition(() => {
          thumb.style.viewTransitionName = '';
          open(url, type, meta);
          const lbImg = _body && _body.querySelector('img');
          if (lbImg) lbImg.style.viewTransitionName = 'lb-morph';
        });
        vt.finished.finally(() => {
          _vtBusy = false;
          const lbImg = _body && _body.querySelector('img');
          if (lbImg) lbImg.style.viewTransitionName = '';
        });
        return;
      }
    }
    _build();
    _currentUrl = url;
    _currentMeta = meta;
    // Render media
    if (type === 'audio') {
      const isT = meta?.genType === 'tts';
      const iconSvg = isT
        ? '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="la-icon"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'
        : '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="la-icon"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
      const title = isT ? 'Text to Speech' : 'Sound Effect';
      _body.innerHTML = `<div class="lightbox-audio">
        ${iconSvg}
        <span class="la-title">${title}</span>
        <audio controls autoplay src="${url}" style="width:100%"></audio>
      </div>`;
    } else if (type === 'video') {
      _body.innerHTML = `<video src="${url}" controls autoplay playsinline style="max-width:min(90vw,1200px);max-height:72vh;border-radius:12px;box-shadow:0 32px 80px rgba(0,0,0,.35)"></video>`;
    } else {
      _body.innerHTML = `<img src="${url}" alt="Preview" draggable="false">`;
    }

    // Render metadata bar
    if (meta) {
      const pills = [];
      if (meta.action) pills.push(meta.action);
      else if (meta.genType) pills.push(_capitalize(meta.genType));
      if (meta.model) pills.push(meta.model);
      if (meta.format) pills.push(meta.format);
      if (meta.date) pills.push(meta.date);
      if (meta.duration) pills.push(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:11px;height:11px;display:inline;vertical-align:-1px;margin-right:2px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${meta.duration}`);
      if (meta.cost) pills.push(meta.cost);
      if (meta.userName) pills.push(meta.userName);
      _metaBar.innerHTML = pills.map((p, i) =>
        (i > 0 ? '<span class="lb-meta-sep"></span>' : '') + `<span class="lb-meta-pill">${p}</span>`
      ).join('');
      _metaBar.style.display = pills.length ? 'flex' : 'none';

      // Creative Direction display (separate box, bottom-right)
      const cdDisplay = _el.querySelector('#lb-cd-display');
      const cdDisplayText = _el.querySelector('#lb-cd-display-text');
      if (cdDisplay && cdDisplayText) {
        if (meta.creativeDirection) {
          cdDisplayText.textContent = meta.creativeDirection;
          cdDisplay.style.display = '';
        } else if (meta.genType === 'image' || meta.genType === 'polish') {
          cdDisplayText.textContent = 'Directed By Keou';
          cdDisplay.style.display = '';
        } else {
          cdDisplay.style.display = 'none';
        }
      }
    } else {
      _metaBar.style.display = 'none';
      const cdHide = _el.querySelector('#lb-cd-display');
      if (cdHide) cdHide.style.display = 'none';
    }

    // Reference image (bottom-left)
    const refEl = _el.querySelector('#lb-ref');
    const refImg = _el.querySelector('#lb-ref-img');
    const refThumb = _el.querySelector('#lb-ref-thumb');
    if (refEl && refImg && refThumb) {
      refThumb.classList.remove('expanded');
      if (meta?.inputUrl) {
        refImg.src = meta.inputUrl;
        refEl.style.display = 'flex';
        // Handle broken ref images gracefully
        refImg.onerror = () => { refEl.style.display = 'none'; };
      } else {
        refEl.style.display = 'none';
      }
    }

    // Render action buttons
    const actions = [];
    if (meta?.onAdapt) {
      actions.push(`<button class="lb-action-btn" id="lb-btn-adapt" title="Adapt All Formats (A)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
        Adapt</button>`);
    }
    if (meta?.onRemix) {
      actions.push(`<button class="lb-action-btn" id="lb-btn-remix" title="Remix (R)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        Remix</button>`);
    }
    if (meta?.onPolish) {
      actions.push(`<button class="lb-action-btn" id="lb-btn-polish" title="Polish (P)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
        Polish</button>`);
    }
    if (meta?.onVideo) {
      actions.push(`<button class="lb-action-btn" id="lb-btn-video" title="Video (V)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Video</button>`);
    }
    if (meta?.onUpscale) {
      actions.push(`<button class="lb-action-btn" id="lb-btn-upscale" title="Upscale 4K (U)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
        Upscale 4K</button>`);
    }
    if (meta?.onPack) {
      actions.push(`<button class="lb-action-btn" id="lb-btn-pack" title="Export Pack (K)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
        Pack</button>`);
    }
    if (meta?.generationId) {
      actions.push(`<button class="lb-action-btn" id="lb-btn-move" title="Move to Campaign (M)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        Move</button>`);
    }
    _actionBar.innerHTML = actions.join('');
    _actionBar.style.display = actions.length ? 'flex' : 'none';

    // Wire action button clicks
    const adaptBtn = _el.querySelector('#lb-btn-adapt');
    if (adaptBtn && meta?.onAdapt) {
      adaptBtn.addEventListener('click', () => { meta.onAdapt(); close(); });
    }
    const remixBtn = _el.querySelector('#lb-btn-remix');
    if (remixBtn && meta?.onRemix) {
      remixBtn.addEventListener('click', _toggleRemix);
    }
    const polishBtn = _el.querySelector('#lb-btn-polish');
    if (polishBtn && meta?.onPolish) {
      polishBtn.addEventListener('click', () => { meta.onPolish(); close(); });
    }
    const videoBtn = _el.querySelector('#lb-btn-video');
    if (videoBtn && meta?.onVideo) {
      videoBtn.addEventListener('click', _toggleCD);
    }
    const upscaleBtn = _el.querySelector('#lb-btn-upscale');
    if (upscaleBtn && meta?.onUpscale) {
      upscaleBtn.addEventListener('click', () => { meta.onUpscale(); close(); });
    }
    const packBtn = _el.querySelector('#lb-btn-pack');
    if (packBtn && meta?.onPack) {
      packBtn.addEventListener('click', () => { meta.onPack(); close(); });
    }
    const moveBtn = _el.querySelector('#lb-btn-move');
    if (moveBtn && meta?.generationId) {
      moveBtn.addEventListener('click', _toggleMove);
    }

    // Reset panels
    _cdWrap.classList.remove('visible');
    const cdInput = _el.querySelector('#lb-cd-input');
    if (cdInput) cdInput.value = '';
    const remixPanel = _el.querySelector('#lb-remix');
    if (remixPanel) remixPanel.classList.remove('visible');
    const remixInput = _el.querySelector('#lb-remix-input');
    if (remixInput) remixInput.value = '';
    const movePanel = _el.querySelector('#lb-move');
    if (movePanel) movePanel.classList.remove('visible');
    // Reset model selection to default (Grok Imagine)
    _el.querySelectorAll('#lb-model-chips .lb-model-chip').forEach(c => c.classList.remove('active'));
    const defaultChip = _el.querySelector('#lb-model-chips .lb-model-chip[data-model="grok-imagine"]');
    if (defaultChip) defaultChip.classList.add('active');

    // Reset duration selection to default (10s)
    _el.querySelectorAll('#lb-duration-chips .lb-model-chip').forEach(c => c.classList.remove('active'));
    const defaultDuration = _el.querySelector('#lb-duration-chips .lb-model-chip[data-duration="10"]');
    if (defaultDuration) defaultDuration.classList.add('active');

    document.body.style.overflow = 'hidden';
    // A11y: remember which element had focus so we can restore on close, then move
    // focus into the dialog so keyboard users start inside it.
    _previousFocus = document.activeElement;
    _el.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        _el.classList.add('open');
        // Focus the close button — first interactive element in the toolbar
        const closeBtn = _el.querySelector('.lb-close');
        if (closeBtn) closeBtn.focus();
      });
    });
  }

  function close() {
    if (!_el) return;
    _el.classList.remove('open');
    _el.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    // Restore focus to the element that opened the lightbox
    if (_previousFocus && typeof _previousFocus.focus === 'function') {
      try { _previousFocus.focus(); } catch {}
      _previousFocus = null;
    }
    _currentUrl = '';
    _currentMeta = null;
    _cdWrap.classList.remove('visible');
    const rp = _el?.querySelector('#lb-remix');
    if (rp) rp.classList.remove('visible');
    const cdDisp = _el?.querySelector('#lb-cd-display');
    if (cdDisp) cdDisp.style.display = 'none';
    const mv = _el?.querySelector('#lb-move');
    if (mv) mv.classList.remove('visible');

    const vid = _body?.querySelector('video');
    if (vid) vid.pause();
    const aud = _body?.querySelector('audio');
    if (aud) aud.pause();

    const refEl = _el?.querySelector('#lb-ref');
    if (refEl) refEl.style.display = 'none';

    setTimeout(() => {
      if (_body) _body.innerHTML = '';
      if (_actionBar) _actionBar.innerHTML = '';
    }, 300);
  }

  function isOpen() {
    return _el?.classList.contains('open') || false;
  }

  function _capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  return { open, close, isOpen };
})();

window.Lightbox = Lightbox;
