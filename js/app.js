// 渲染与交互层：SVG 棋盘 + 水墨风 UI + 人机对弈 + 数子 + 死活题 + 持久化 + PWA
(function () {
  var Board = window.WeiqiBoard;
  var LightAI = window.LightAI;
  var SGF = window.SGF;
  var Store = window.Store;
  var PROBLEMS = (window.TSUMEGO_PROBLEMS || []).slice();
  var KataEngine = window.KataEngine;   // 真·KataGo WASM 引擎(可能不可用)
  var kataInitStarted = false;          // 是否已触发过模型加载

  var CELL = 34, MARGIN = 26;
  var LETTERS = 'ABCDEFGHJKLMNOPQRST';

  // ===================== 共享棋盘绘制 =====================
  function dim(size) { return MARGIN * 2 + CELL * (size - 1); }

  function el(tag, attrs) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function makeGrad(id, c0, c1, c2) {
    var g = el('radialGradient', { id: id, cx: '35%', cy: '30%', r: '75%' });
    g.appendChild(el('stop', { offset: '0%', 'stop-color': c0 }));
    g.appendChild(el('stop', { offset: '55%', 'stop-color': c1 }));
    g.appendChild(el('stop', { offset: '100%', 'stop-color': c2 }));
    return g;
  }

  // 通用绘制：container 内渲染 board；opts: {markers, onClick, scoring, coords}
  function drawBoard(container, board, opts) {
    opts = opts || {};
    var d = dim(board.size);
    var svg = el('svg', { width: d, height: d, viewBox: '0 0 ' + d + ' ' + d, class: opts.scoring ? 'scoring' : '' });
    svg.style.touchAction = 'none';

    var defs = el('defs');
    defs.appendChild(makeGrad('blk', '#525252', '#1b1b1b', '#080808'));
    defs.appendChild(makeGrad('wht', '#ffffff', '#f3ecd8', '#d9d1ba'));
    svg.appendChild(defs);
    svg.appendChild(el('rect', { x: 0, y: 0, width: d, height: d, fill: '#efe6cf', rx: 6 }));

    var g = el('g', { stroke: '#3a342a', 'stroke-width': 1 });
    for (var i = 0; i < board.size; i++) {
      var p = MARGIN + i * CELL;
      g.appendChild(el('line', { x1: p, y1: MARGIN, x2: p, y2: MARGIN + (board.size - 1) * CELL }));
      g.appendChild(el('line', { x1: MARGIN, y1: p, x2: MARGIN + (board.size - 1) * CELL, y2: p }));
    }
    svg.appendChild(g);

    var stars = board.starPoints();
    for (var s = 0; s < stars.length; s++) {
      svg.appendChild(el('circle', { cx: MARGIN + stars[s][0] * CELL, cy: MARGIN + stars[s][1] * CELL, r: 3.2, fill: '#3a342a' }));
    }

    if (opts.coords !== false) {
      var co = el('g', { fill: '#9a8f76', 'font-size': 11, 'font-family': 'serif', 'text-anchor': 'middle' });
      for (var i2 = 0; i2 < board.size; i2++) {
        var px = MARGIN + i2 * CELL;
        var t1 = el('text', { x: px, y: MARGIN - 10 }); t1.textContent = LETTERS[i2]; co.appendChild(t1);
        var t2 = el('text', { x: px, y: MARGIN + (board.size - 1) * CELL + 18 }); t2.textContent = LETTERS[i2]; co.appendChild(t2);
        var py = MARGIN + i2 * CELL;
        var rn = board.size - i2;
        var t3 = el('text', { x: MARGIN - 14, y: py + 4 }); t3.textContent = rn; co.appendChild(t3);
        var t4 = el('text', { x: MARGIN + (board.size - 1) * CELL + 16, y: py + 4 }); t4.textContent = rn; co.appendChild(t4);
      }
      svg.appendChild(co);
    }

    var r2 = CELL * 0.46;
    for (var y = 0; y < board.size; y++) {
      for (var x = 0; x < board.size; x++) {
        var v = board.grid[y][x];
        if (v) {
          var cx = MARGIN + x * CELL, cy = MARGIN + y * CELL;
          var dead = board.isDead ? board.isDead(x, y) : false;
          svg.appendChild(el('circle', {
            cx: cx, cy: cy, r: r2,
            fill: v === 1 ? 'url(#blk)' : 'url(#wht)',
            stroke: v === 2 ? '#b9b09a' : 'none', 'stroke-width': v === 2 ? 1 : 0,
            opacity: dead ? 0.32 : 1
          }));
          if (dead) {
            var o = r2 * 0.6;
            svg.appendChild(el('line', { x1: cx - o, y1: cy - o, x2: cx + o, y2: cy + o, stroke: '#b03a2e', 'stroke-width': 2 }));
            svg.appendChild(el('line', { x1: cx - o, y1: cy + o, x2: cx + o, y2: cy - o, stroke: '#b03a2e', 'stroke-width': 2 }));
          }
        }
      }
    }

    if (board.lastMove && !board.lastMove.pass) {
      svg.appendChild(el('circle', { cx: MARGIN + board.lastMove.x * CELL, cy: MARGIN + board.lastMove.y * CELL, r: CELL * 0.2, fill: 'none', stroke: '#b03a2e', 'stroke-width': 2 }));
    }

    // 标注 / 死活题标记
    if (opts.markers) {
      opts.markers.forEach(function (m) {
        var mx = MARGIN + m.x * CELL, my = MARGIN + m.y * CELL;
        if (m.type === 'cross') {
          var o = CELL * 0.3;
          svg.appendChild(el('line', { x1: mx - o, y1: my - o, x2: mx + o, y2: my + o, stroke: '#b03a2e', 'stroke-width': 2.4 }));
          svg.appendChild(el('line', { x1: mx - o, y1: my + o, x2: mx + o, y2: my - o, stroke: '#b03a2e', 'stroke-width': 2.4 }));
        } else if (m.type === 'circle') {
          svg.appendChild(el('circle', { cx: mx, cy: my, r: CELL * 0.36, fill: 'none', stroke: m.color || '#b03a2e', 'stroke-width': 2.2 }));
        } else if (m.type === 'triangle') {
          var a = CELL * 0.36;
          svg.appendChild(el('path', { d: 'M' + mx + ' ' + (my - a) + ' L' + (mx + a) + ' ' + (my + a * 0.8) + ' L' + (mx - a) + ' ' + (my + a * 0.8) + ' Z', fill: 'none', stroke: m.color || '#2f6f5e', 'stroke-width': 2.2 }));
        } else if (m.type === 'num') {
          svg.appendChild(el('circle', { cx: mx, cy: my, r: CELL * 0.34, fill: 'none', stroke: '#3a342a', 'stroke-width': 1.6 }));
          var tx = el('text', { x: mx, y: my + 4, 'text-anchor': 'middle', 'font-size': 13, fill: '#3a342a', 'font-family': 'serif' });
          tx.textContent = m.label || ''; svg.appendChild(tx);
        }
      });
    }

    container.innerHTML = '';
    container.appendChild(svg);
    if (opts.onClick) svg.addEventListener('click', opts.onClick);
    return svg;
  }

  // ===================== 对局状态 =====================
  var board = new Board(19);
  var mode = 'pvp', humanColor = 1, aiColor = 2, aiLevel = 'junior', aiDelay = 250;
  var aiThinking = false, scoring = false, gameOver = false;
  var playMarkers = [], annotMode = false, annotType = 'cross', numCounter = 0;
  var timerStart = 0, timerInt = null, lastResult = '';

  function fmtTime(sec) {
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function startTimer() { stopTimer(); timerStart = Date.now(); timerInt = setInterval(updateTimer, 500); }
  function stopTimer() { if (timerInt) clearInterval(timerInt); timerInt = null; }
  function updateTimer() { if (gameOver) return; var s = Math.floor((Date.now() - timerStart) / 1000); var te = document.getElementById('timer'); if (te) te.textContent = fmtTime(s); }

  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 1600);
  }

  function renderPlay() {
    drawBoard(document.getElementById('board'), board, {
      markers: playMarkers, scoring: scoring,
      onClick: onPlayClick
    });
  }

  function updateInfo() {
    var turnEl = document.getElementById('turn');
    var c = board.current;
    var role = (mode === 'pve') ? (c === humanColor ? '（你）' : '（AI）') : '';
    turnEl.textContent = (c === 1 ? '黑' : '白') + role;
    turnEl.className = 'tag ' + (c === 1 ? 'black' : 'white');
    document.getElementById('moves').textContent = board.history.length;
  }

  function onPlayClick(ev) {
    var svg = ev.currentTarget;
    var rect = svg.getBoundingClientRect();
    var d = dim(board.size);
    var px = (ev.clientX - rect.left) * (d / rect.width);
    var py = (ev.clientY - rect.top) * (d / rect.height);
    var x = Math.round((px - MARGIN) / CELL);
    var y = Math.round((py - MARGIN) / CELL);
    if (x < 0 || y < 0 || x >= board.size || y >= board.size) return;

    if (scoring) { if (board.grid[y][x]) { board.toggleDead(x, y); renderPlay(); updateScoreCard(); } return; }
    if (gameOver) { toast('本局已结束，请重新开局'); return; }

    if (annotMode) {
      if (board.grid[y][x] !== 0) { toast('请在空点做标注'); return; }
      var idx = -1;
      for (var i = 0; i < playMarkers.length; i++) if (playMarkers[i].x === x && playMarkers[i].y === y) idx = i;
      if (idx >= 0) playMarkers.splice(idx, 1);
      else {
        var label = '';
        if (annotType === 'num') label = String(++numCounter);
        playMarkers.push({ x: x, y: y, type: annotType, label: label });
      }
      renderPlay(); return;
    }

    if (mode === 'pve' && board.current === aiColor) { toast('等 AI 落子…'); return; }
    var res = board.play(x, y);
    if (res.ok) afterMove();
    else if (res.ko) toast('劫争禁着：须先到别处行棋（找劫材）');
    else if (res.suicide) toast('禁着：自杀手');
  }

  function afterMove() {
    if (board.history.length === 1) startTimer();
    renderPlay(); updateInfo();
    if (mode === 'pve' && board.current === aiColor) scheduleAI();
  }

  function scheduleAI() {
    if (aiThinking) return;
    aiThinking = true;
    setTimeout(function () { aiThinking = false; aiStep(); }, aiDelay);
  }

  function aiStep() {
    if (board.current !== aiColor) return;
    // 中级/高级 且 KataGo 已就绪 -> 用真模型
    if (useKata() && KataEngine && KataEngine.status() === 'ready') {
      aiThinking = true;
      showKataThink(true);
      KataEngine.genmove(board, aiColor, { visits: KataEngine.defaultVisits(board.size) })
        .then(function (res) {
          aiThinking = false;
          showKataThink(false);
          applyKataMove(res);
        })
        .catch(function (err) {
          aiThinking = false;
          showKataThink(false);
          // 推理超时/失败：自动回退到内置 AI，不让对局卡住
          if (err && /超时|无响应|卡死/.test(err.message)) {
            toast('KataGo 推理较慢/超时，本手改用内置 AI');
          }
          aiStepLight(); // 本次推理失败，回退内置 AI
        });
      return;
    }
    aiStepLight();
  }

  // 内置轻量/搜索 AI 落子(原 aiStep 逻辑)
  function aiStepLight() {
    if (board.current !== aiColor) return;
    var mv = LightAI.chooseMove(board, aiColor, { level: aiLevel });
    if (!mv) {
      board.pass(aiColor);
      toast('AI 无棋可下，停一手（可数子判定）');
      renderPlay(); updateInfo(); checkDoublePass(); return;
    }
    var r = board.play(mv.x, mv.y, aiColor);
    if (r.ok) {
      renderPlay(); updateInfo();
      if (mode === 'pve' && board.current === aiColor) scheduleAI();
    }
  }

  // ===================== KataGo 引擎集成 =====================
  function useKata() {
    return mode === 'pve' && (aiLevel === 'middle' || aiLevel === 'advanced');
  }

  function ensureKata() {
    if (kataInitStarted) return;
    kataInitStarted = true;
    updateEngineTag();
    showKataOverlayLoading();
    KataEngine.init({
      onProgress: updateKataProgress,
      onThinking: function (p) {
        if (p != null && p >= 0) {
          var t = document.getElementById('katago-think-text');
          if (t) t.textContent = 'AI 思考中… ' + Math.round(p * 100) + '%';
        }
      },
      onStatus: function (s) {
        if (s === 'ready') {
          hideKataOverlay();
          updateEngineTag();
          toast('KataGo 已就绪，开始思考');
          if (mode === 'pve' && board.current === aiColor && !gameOver) scheduleAI();
        } else if (s === 'fallback') {
          showKataFallback();
          updateEngineTag();
          toast('KataGo 不可用，已回退到内置 AI');
          if (mode === 'pve' && board.current === aiColor && !gameOver) scheduleAI();
        }
      }
    });
  }

  function applyKataMove(res) {
    if (res.pass || !res.move) {
      board.pass(aiColor);
      var wr = (res.winrate != null) ? Math.round(res.winrate * 100) : null;
      toast('AI 停一手' + (wr != null ? '（胜率 ' + wr + '%）' : ''));
      checkDoublePass();
    } else {
      var r = board.play(res.move.x, res.move.y, aiColor);
      if (!r.ok) { aiStepLight(); return; } // 极少见：模型给非法点
      var pct = (res.winrate != null) ? Math.round(res.winrate * 100) : null;
      toast('AI 落子' + (pct != null ? ' · 胜率 ' + pct + '%' : ''));
    }
    renderPlay(); updateInfo();
    if (mode === 'pve' && board.current === aiColor) scheduleAI();
  }

  // ---- 加载遮罩 ----
  function showKataOverlayLoading() {
    var ov = document.getElementById('katago-overlay');
    var ok = document.getElementById('katago-ok');
    var title = document.getElementById('katago-title');
    var msg = document.getElementById('katago-msg');
    var sub = document.getElementById('katago-sub');
    var barWrap = document.getElementById('katago-bar-wrap');
    if (ok) ok.classList.add('hidden');
    if (title) title.textContent = '正在唤醒 AI 大脑…';
    if (msg) msg.innerHTML = '首次需下载围棋模型（约 80&nbsp;MB），请稍候';
    if (sub) sub.textContent = '';
    if (barWrap) barWrap.classList.remove('indeterminate');
    updateKataProgress(0);
    if (ov) ov.classList.remove('hidden');
  }
  function updateKataProgress(p) {
    var bar = document.getElementById('katago-bar');
    var barWrap = document.getElementById('katago-bar-wrap');
    var sub = document.getElementById('katago-sub');
    if (!bar) return;
    if (p < 0) {
      barWrap.classList.add('indeterminate');
      if (sub) sub.textContent = '正在连接模型…';
    } else {
      barWrap.classList.remove('indeterminate');
      bar.style.width = Math.max(2, Math.round(p * 100)) + '%';
      if (sub) sub.textContent = Math.round(p * 100) + '%';
    }
  }
  function hideKataOverlay() {
    var ov = document.getElementById('katago-overlay');
    if (ov) ov.classList.add('hidden');
  }
  function showKataFallback() {
    var ov = document.getElementById('katago-overlay');
    var title = document.getElementById('katago-title');
    var m = document.getElementById('katago-msg');
    var barWrap = document.getElementById('katago-bar-wrap');
    var ok = document.getElementById('katago-ok');
    if (barWrap) barWrap.classList.remove('indeterminate');
    if (title) title.textContent = '未加载 KataGo 模型';
    if (m) m.innerHTML = '模型文件缺失或下载失败。<br>已自动切换为内置搜索 AI，可正常对弈。<br>' +
      '<span style="font-size:12px">如需真模型：终端运行 <b>bash katago/fetch_model.sh</b> 下载，再硬刷新页面。</span>';
    if (ok) ok.classList.remove('hidden');
    if (ov) ov.classList.remove('hidden');
  }
  function showKataThink(on, text) {
    var el = document.getElementById('katago-think');
    if (!el) return;
    if (on) {
      var t = document.getElementById('katago-think-text');
      if (t) t.textContent = (text || 'AI 思考中…');
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }
  function updateEngineTag() {
    var el = document.getElementById('engine-tag');
    if (!el) return;
    if (!useKata()) {
      el.textContent = '轻量 AI';
      el.style.background = 'rgba(58,52,42,0.08)'; el.style.color = 'var(--ink-soft)';
      return;
    }
    var st = KataEngine ? KataEngine.status() : 'idle';
    if (st === 'ready') { el.textContent = 'KataGo'; el.style.background = 'var(--cinnabar)'; el.style.color = '#fff'; }
    else if (st === 'fallback') { el.textContent = '搜索 AI(内置)'; el.style.background = 'rgba(58,52,42,0.08)'; el.style.color = 'var(--ink-soft)'; }
    else { el.textContent = '加载中…'; el.style.background = 'rgba(58,52,42,0.08)'; el.style.color = 'var(--ink-soft)'; }
  }

  function humanPass() {
    if (gameOver || scoring) return;
    if (mode === 'pve' && board.current !== humanColor) { toast('等 AI 落子…'); return; }
    board.pass();
    toast('你停一手（虚手）');
    renderPlay(); updateInfo(); checkDoublePass();
    if (!gameOver && mode === 'pve' && board.current === aiColor) scheduleAI();
  }

  function checkDoublePass() {
    var h = board.history;
    if (h.length >= 2 && h[h.length - 1].pass && h[h.length - 2].pass) {
      toast('双方停手，自动数子'); enterScoring();
    }
  }

  function enterScoring() {
    scoring = true; renderPlay(); updateScoreCard();
    document.getElementById('scorecard').classList.remove('hidden');
  }
  function updateScoreCard() {
    var s = board.score();
    var resText, resCls;
    if (s.winner === 1) { resText = '黑胜 ' + s.margin.toFixed(1) + ' 子'; resCls = 'black'; }
    else if (s.winner === 2) { resText = '白胜 ' + s.margin.toFixed(1) + ' 子'; resCls = 'white'; }
    else { resText = '和棋'; resCls = ''; }
    var html = '';
    html += scRow('黑', s.blackStones + ' 子 + ' + s.blackTerr + ' 目', s.black.toFixed(1), 'black');
    html += scRow('白', s.whiteStones + ' 子 + ' + s.whiteTerr + ' 目 + 贴 ' + s.komi, s.white.toFixed(1), 'white');
    html += '<div class="sc-result ' + resCls + '">' + resText + '</div>';
    if (s.dame > 0) html += '<div class="sc-dame">单官（不计）' + s.dame + ' 目</div>';
    document.getElementById('sc-body').innerHTML = html;
    if (gameOver) document.getElementById('sc-confirm').textContent = '重新开局';
  }
  function scRow(name, detail, total, cls) {
    return '<div class="sc-line"><span class="sc-name ' + cls + '">' + name + '</span><span class="sc-detail">' + detail + '</span><span class="sc-total">' + total + '</span></div>';
  }
  function confirmScoring() {
    if (gameOver) { resetGame(); return; }
    gameOver = true; stopTimer(); lastResult = document.querySelector('.sc-result').textContent;
    document.getElementById('sc-resume').classList.add('hidden');
    document.getElementById('sc-confirm').textContent = '重新开局';
    toast('已确认数子结果');
    saveGameRecord();
  }
  function resumeFromScoring() {
    scoring = false; board.clearDead();
    document.getElementById('scorecard').classList.add('hidden');
    renderPlay();
  }

  function newGame(size) {
    if (window.KataEngine && KataEngine.cancelCurrent) KataEngine.cancelCurrent();
    if (size) board.reset(size); else board.reset();
    applyHandicapFromUI();
    scoring = false; gameOver = false; playMarkers = []; numCounter = 0;
    document.getElementById('scorecard').classList.add('hidden');
    var c = document.getElementById('sc-confirm'); c.textContent = '确认数子'; c.onclick = confirmScoring;
    document.getElementById('sc-resume').classList.remove('hidden');
    renderPlay(); updateInfo(); startTimer();
    if (mode === 'pve' && board.current === aiColor) scheduleAI();
  }
  function applyHandicapFromUI() {
    var h = parseInt(document.getElementById('handicap').value, 10) || 0;
    board.applyHandicap(h);
  }
  function resetGame() { newGame(); }

  function startPve() {
    board.reset();
    humanColor = parseInt(document.querySelector('[data-human].active').getAttribute('data-human'), 10);
    aiColor = (humanColor === 1) ? 2 : 1;
    applyHandicapFromUI();
    scoring = false; gameOver = false; playMarkers = []; numCounter = 0;
    document.getElementById('scorecard').classList.add('hidden');
    var c = document.getElementById('sc-confirm'); c.textContent = '确认数子'; c.onclick = confirmScoring;
    document.getElementById('sc-resume').classList.remove('hidden');
    renderPlay(); updateInfo(); startTimer();
    updateEngineTag();
    if (useKata()) {
      var st = (KataEngine ? KataEngine.status() : 'idle');
      if (st === 'ready' || st === 'fallback') {
        if (board.current === aiColor) scheduleAI();
      } else {
        ensureKata(); // 加载完成后由 onStatus 触发 AI
      }
      return;
    }
    if (board.current === aiColor) scheduleAI();
  }

  function exportSGF() {
    var sgf = SGF.serialize(board, { komi: board.komi, result: lastResult });
    var blob = new Blob([sgf], { type: 'application/x-go-sgf' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = '对局-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.sgf';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('已导出 SGF');
  }

  function saveGameRecord() {
    var s = board.score();
    Store.addGame({
      date: new Date().toISOString(), size: board.size,
      mode: mode, level: (mode === 'pve' ? aiLevel : '-'),
      handicap: board.handicap, moves: board.history.length,
      result: lastResult, sgf: SGF.serialize(board, { komi: board.komi, result: lastResult })
    });
  }

  // ===================== 死活题 =====================
  var tBoard = new Board(9);
  var curIdx = -1, tMarkers = [], tTurn = 1;

  function loadProblems() {
    return Store.getImported().then(function (imp) {
      imp.forEach(function (p) { PROBLEMS.push(p); });
      return PROBLEMS;
    });
  }

  function selectProblem(idx) {
    if (idx < 0 || idx >= PROBLEMS.length) return;
    curIdx = idx;
    var p = PROBLEMS[idx];
    tBoard = new Board(p.size);
    var o = SGF.parse('(;' + p.setup + ')');
    o.black.forEach(function (s) { tBoard.setStone(s.x, s.y, 1); });
    o.white.forEach(function (s) { tBoard.setStone(s.x, s.y, 2); });
    tMarkers = []; tTurn = p.solver || 1;
    document.getElementById('tstatus').textContent = '';
    document.getElementById('tstatus').className = 'tstatus';
    renderTsumego();
    renderTsInfo();
    highlightList();
  }

  function renderTsumego() {
    drawBoard(document.getElementById('tboard'), tBoard, { markers: tMarkers, onClick: onTsumegoClick });
  }

  function onTsumegoClick(ev) {
    var svg = ev.currentTarget;
    var rect = svg.getBoundingClientRect();
    var d = dim(tBoard.size);
    var px = (ev.clientX - rect.left) * (d / rect.width);
    var py = (ev.clientY - rect.top) * (d / rect.height);
    var x = Math.round((px - MARGIN) / CELL);
    var y = Math.round((py - MARGIN) / CELL);
    if (x < 0 || y < 0 || x >= tBoard.size || y >= tBoard.size) return;
    var p = PROBLEMS[curIdx];
    if (!p) return;

    if (p.answers == null) { // 导入题：自由练习
      if (tBoard.grid[y][x] !== 0) return;
      var r = tBoard.play(x, y, tTurn);
      if (r.ok) { tTurn = tTurn === 1 ? 2 : 1; renderTsumego(); }
      return;
    }

    // 已解题则不再判
    if (document.getElementById('tstatus').dataset.done === '1') return;

    var isAnswer = p.answers.some(function (a) { return a[0] === x && a[1] === y; });
    if (isAnswer) {
      tBoard.play(x, y, p.solver);
      setStatus('正解正确！', 'ok');
      document.getElementById('tstatus').dataset.done = '1';
      renderTsumego();
      markTsumego(p.id, true, false);
    } else {
      // 标记叉号 + 揭示正解点
      tMarkers.push({ x: x, y: y, type: 'cross' });
      tMarkers.push({ x: p.answers[0][0], y: p.answers[0][1], type: 'circle', color: '#2f6f5e' });
      setStatus('不是正解，绿圈为正解点', 'bad');
      renderTsumego();
      markTsumego(p.id, false, true);
    }
  }

  function setStatus(text, cls) {
    var e = document.getElementById('tstatus');
    e.textContent = text; e.className = 'tstatus ' + (cls || '');
  }

  function markTsumego(id, solved, wrong) {
    Store.getTsumego().then(function (map) {
      var prev = map[id] || { attempts: 0 };
      Store.setTsumego(id, {
        solved: solved ? true : (prev.solved || false),
        wrong: wrong ? true : (prev.wrong || false),
        attempts: (prev.attempts || 0) + 1
      });
      renderTsStats(); renderTsList();
    });
  }

  function showSolution() {
    var p = PROBLEMS[curIdx];
    if (!p || p.answers == null) { toast('该题无标准解（导入题）'); return; }
    tMarkers = [];
    p.answers.forEach(function (a, i) {
      tMarkers.push({ x: a[0], y: a[1], type: 'num', label: String(i + 1) });
    });
    renderTsumego();
    setStatus('正解点（数字标序）', '');
  }

  function renderTsInfo() {
    var p = PROBLEMS[curIdx];
    if (!p) { document.getElementById('ts-info').innerHTML = ''; return; }
    var goalText = p.goal === 'live' ? '目标：做活（做出两只眼）' : (p.goal === 'kill' ? '目标：杀棋（让对方凑不出两眼）' : '自由练习（导入题）');
    document.getElementById('ts-info').innerHTML =
      '<div class="ts-title">' + p.title + '</div>' +
      '<div class="ts-meta">类型：' + p.type + ' ｜ 难度：' + p.difficulty + '</div>' +
      '<div class="ts-goal">' + goalText + '</div>';
  }

  function getProgressMap(cb) { Store.getTsumego().then(cb); }

  function renderTsStats() {
    getProgressMap(function (map) {
      var total = PROBLEMS.length, solved = 0, wrong = 0;
      PROBLEMS.forEach(function (p) { var d = map[p.id]; if (d && d.solved) solved++; if (d && d.wrong) wrong++; });
      var rate = total ? Math.round(solved / total * 100) : 0;
      document.getElementById('ts-stats').innerHTML =
        '已做 ' + solved + '/' + total + ' ｜ 正确率 ' + rate + '% ｜ <span class="wrong-c">错题 ' + wrong + '</span>';
    });
  }

  function filteredProblems() {
    var type = document.getElementById('ts-type').value;
    var diff = document.getElementById('ts-diff').value;
    var wrongOnly = document.getElementById('ts-wrong').classList.contains('active');
    return PROBLEMS.filter(function (p) {
      if (type && p.type !== type) return false;
      if (diff && p.difficulty !== diff) return false;
      return true;
    }).filter(function (p) {
      if (!wrongOnly) return true;
      return true; // 错题过滤在渲染时按 map 判定
    });
  }

  function renderTsList() {
    getProgressMap(function (map) {
      var type = document.getElementById('ts-type').value;
      var diff = document.getElementById('ts-diff').value;
      var wrongOnly = document.getElementById('ts-wrong').classList.contains('active');
      var list = PROBLEMS.filter(function (p) {
        if (type && p.type !== type) return false;
        if (diff && p.difficulty !== diff) return false;
        if (wrongOnly && !(map[p.id] && map[p.id].wrong)) return false;
        return true;
      });
      var html = '';
      list.forEach(function (p) {
        var d = map[p.id];
        var mark = d && d.solved ? '✓' : (d && d.wrong ? '✗' : '');
        var cls = d && d.solved ? 'done' : (d && d.wrong ? 'wrong' : '');
        var idx = PROBLEMS.indexOf(p);
        html += '<div class="ts-item ' + (idx === curIdx ? 'cur ' : '') + cls + '" data-idx="' + idx + '">' +
          '<span class="ts-mark">' + mark + '</span>' + p.title + '</div>';
      });
      if (!list.length) html = '<div class="ts-empty">暂无题目</div>';
      document.getElementById('ts-list').innerHTML = html;
      Array.prototype.forEach.call(document.querySelectorAll('.ts-item'), function (it) {
        it.addEventListener('click', function () { selectProblem(parseInt(it.getAttribute('data-idx'), 10)); });
      });
    });
  }
  function highlightList() {
    Array.prototype.forEach.call(document.querySelectorAll('.ts-item'), function (it) {
      it.classList.toggle('cur', parseInt(it.getAttribute('data-idx'), 10) === curIdx);
    });
  }

  function importSGF(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var text = reader.result;
      var parsed = SGF.parse(text);
      var setup = '';
      if (parsed.black.length) setup += 'AB' + parsed.black.map(function (s) { return '[' + LETTERS[s.x] + LETTERS[s.y] + ']'; }).join('');
      if (parsed.white.length) setup += 'AW' + parsed.white.map(function (s) { return '[' + LETTERS[s.x] + LETTERS[s.y] + ']'; }).join('');
      if (!setup) { toast('未解析到棋子'); return; }
      var prob = {
        id: 'imp' + Date.now(), title: '导入题', difficulty: '-', type: '导入',
        tags: [], size: parsed.size, setup: setup, solver: 1, goal: 'study', answers: null
      };
      Store.addImported(prob).then(function () {
        PROBLEMS.push(prob);
        toast('已导入 1 题');
        renderTsList(); renderTsStats();
        selectProblem(PROBLEMS.length - 1);
      });
    };
    reader.readAsText(file);
  }

  // ===================== 绑定与初始化 =====================
  function bind() {
    document.querySelectorAll('[data-size]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('[data-size]').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        newGame(parseInt(b.getAttribute('data-size'), 10));
      });
    });
    document.querySelectorAll('[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('[data-mode]').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        mode = b.getAttribute('data-mode');
        document.querySelector('.pve-only').classList.toggle('hidden', mode !== 'pve');
        if (mode === 'pve') startPve();
        else { board.reset(); applyHandicapFromUI(); renderPlay(); updateInfo(); startTimer(); }
      });
    });
    document.querySelectorAll('[data-level]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('[data-level]').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        aiLevel = b.getAttribute('data-level');
        Store.setSetting('aiLevel', aiLevel);
        updateEngineTag();
        if (mode === 'pve') {
          toast('难度：' + b.textContent);
          if (useKata()) ensureKata(); // 切换强度时按需加载真模型
        }
      });
    });
    var katagoOk = document.getElementById('katago-ok');
    if (katagoOk) katagoOk.addEventListener('click', hideKataOverlay);
    document.querySelectorAll('[data-human]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('[data-human]').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        if (mode === 'pve') startPve();
      });
    });
    document.getElementById('handicap').addEventListener('change', function () {
      Store.setSetting('handicap', this.value);
      if (mode === 'pve') startPve(); else newGame();
    });
    document.getElementById('aispeed').addEventListener('change', function () {
      aiDelay = parseInt(this.value, 10); Store.setSetting('aiDelay', aiDelay);
    });
    document.getElementById('annot-toggle').addEventListener('click', function () {
      annotMode = !annotMode;
      this.textContent = annotMode ? '开' : '关';
      this.classList.toggle('on', annotMode);
      document.getElementById('annot-tools').classList.toggle('hidden', !annotMode);
      if (annotMode) toast('标注模式：点空点做记号');
    });
    document.querySelectorAll('[data-mtype]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('[data-mtype]').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active'); annotType = b.getAttribute('data-mtype');
      });
    });
    document.getElementById('annot-clear').addEventListener('click', function () {
      playMarkers = []; numCounter = 0; renderPlay();
    });

    document.getElementById('undo').addEventListener('click', function () {
      if (!board.history.length) { toast('没有可悔的棋'); return; }
      if (window.KataEngine && KataEngine.cancelCurrent) KataEngine.cancelCurrent();
      board.undo();
      if (mode === 'pve' && board.history.length && board.current === aiColor) board.undo();
      scoring = false; gameOver = false;
      document.getElementById('scorecard').classList.add('hidden');
      renderPlay(); updateInfo();
    });
    document.getElementById('reset').addEventListener('click', resetGame);
    document.getElementById('pass').addEventListener('click', humanPass);
    document.getElementById('count').addEventListener('click', function () { if (gameOver) return; if (!scoring) enterScoring(); });
    document.getElementById('sc-confirm').addEventListener('click', confirmScoring);
    document.getElementById('sc-resume').addEventListener('click', resumeFromScoring);
    document.getElementById('export').addEventListener('click', exportSGF);

    // 死活题
    document.getElementById('ts-prev').addEventListener('click', function () { selectProblem(curIdx - 1); });
    document.getElementById('ts-next').addEventListener('click', function () { selectProblem(curIdx + 1); });
    document.getElementById('ts-solution').addEventListener('click', showSolution);
    document.getElementById('ts-wrong').addEventListener('click', function () { this.classList.toggle('active'); renderTsList(); });
    document.getElementById('ts-type').addEventListener('change', renderTsList);
    document.getElementById('ts-diff').addEventListener('change', renderTsList);
    document.getElementById('ts-import').addEventListener('change', function () { if (this.files[0]) importSGF(this.files[0]); });

    document.querySelectorAll('[data-tab]').forEach(function (t) {
      t.addEventListener('click', function () {
        document.querySelectorAll('[data-tab]').forEach(function (x) { x.classList.remove('active'); });
        t.classList.add('active');
        var id = t.getAttribute('data-tab');
        document.getElementById('view-play').classList.toggle('hidden', id !== 'play');
        document.getElementById('view-tsumego').classList.toggle('hidden', id !== 'tsumego');
        if (id === 'tsumego') { renderTsList(); renderTsStats(); if (curIdx < 0) selectProblem(0); else renderTsumego(); }
      });
    });
  }

  function applySettings() {
    return Store.getSetting('aiLevel').then(function (v) {
      if (v) { aiLevel = v; var b = document.querySelector('[data-level="' + v + '"]'); if (b) { document.querySelectorAll('[data-level]').forEach(function (x) { x.classList.remove('active'); }); b.classList.add('active'); } }
      return Store.getSetting('aiDelay');
    }).then(function (v) {
      if (v != null) { aiDelay = v; document.getElementById('aispeed').value = String(v); }
      return Store.getSetting('handicap');
    }).then(function (v) {
      if (v != null) document.getElementById('handicap').value = String(v);
    });
  }

  function registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    bind();
    Store.init().then(function () {
      return applySettings();
    }).then(function () {
      renderPlay(); updateInfo();
      return loadProblems();
    }).then(function () {
      renderTsList(); renderTsStats();
    });
    registerSW();
  });
})();
