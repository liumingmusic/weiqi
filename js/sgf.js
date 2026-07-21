// SGF 工具：序列化对局 / 解析（摆题与导入题库）
(function (global) {
  var LETTERS = 'abcdefghjklmnopqrstuvwxyz'; // 跳过 i

  function toCoord(x, y) { return LETTERS[x] + LETTERS[y]; }

  // 将对局序列化为 SGF 文本
  function serialize(board, meta) {
    meta = meta || {};
    var sz = board.size;
    var s = '(;GM[1]FF[4]CA[UTF-8]SZ[' + sz + ']';
    if (board.handicap > 1) {
      s += 'HA[' + board.handicap + ']';
      var ab = board.handicapStones.map(function (p) { return '[' + toCoord(p[0], p[1]) + ']'; }).join('');
      s += 'AB' + ab;
    }
    if (meta.komi != null) s += 'KM[' + meta.komi + ']';
    if (meta.result) s += 'RE[' + meta.result + ']';
    s += '\n';
    for (var i = 0; i < board.history.length; i++) {
      var h = board.history[i];
      if (h.pass) {
        s += ';' + (h.color === 1 ? 'B' : 'W') + '[]\n';
      } else {
        s += ';' + (h.color === 1 ? 'B' : 'W') + '[' + toCoord(h.x, h.y) + ']\n';
      }
    }
    s += ')';
    return s;
  }

  // 解析 SGF：返回 { size, black:[{x,y}], white:[...], toMove, moves:[{c,x,y,pass}] }
  function parse(text) {
    text = (text || '').replace(/\s+/g, ' ');
    var size = 19;
    var m = text.match(/SZ\[(\d+)\]/);
    if (m) size = parseInt(m[1], 10);
    var out = { size: size, black: [], white: [], toMove: 1, moves: [] };

    function readList(prop) {
      var re = new RegExp(prop + '(\\[[a-z][a-z]\\])+', 'g');
      var mm;
      while ((mm = re.exec(text))) {
        var seg = mm[0].slice(prop.length);
        var coordRe = /\[([a-z])([a-z])\]/g, cm;
        while ((cm = coordRe.exec(seg))) {
          out[prop === 'AB' ? 'black' : 'white'].push({ x: LETTERS.indexOf(cm[1]), y: LETTERS.indexOf(cm[2]) });
        }
      }
    }
    readList('AB'); readList('AW'); readList('AE');

    // 走子序列
    var moveRe = /;([BW])\[([a-z]?)([a-z]?)\]/g, mo;
    while ((mo = moveRe.exec(text))) {
      var c = mo[1] === 'B' ? 1 : 2;
      if (mo[2] === '' && mo[3] === '') out.moves.push({ c: c, pass: true });
      else out.moves.push({ c: c, x: LETTERS.indexOf(mo[2]), y: LETTERS.indexOf(mo[3]) });
    }
    // 谁先手：若有让子(AB>1)则白先，否则黑先；这里简单以 moves[0] 决定
    if (out.moves.length) out.toMove = out.moves[0].c === 1 ? 2 : 1;
    else out.toMove = (out.black.length > 1) ? 2 : 1;
    return out;
  }

  global.SGF = { serialize: serialize, parse: parse, toCoord: toCoord };
})(window);
