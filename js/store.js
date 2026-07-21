// 本地存储封装：IndexedDB 为主，localStorage 兜底（file:// 打开或环境不支持时）
(function (global) {
  var DB_NAME = 'weiqi-site', DB_VER = 1;
  var db = null, useLS = false;

  function open() {
    return new Promise(function (resolve) {
      try {
        if (!global.indexedDB) { useLS = true; return resolve(); }
        var req = global.indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = function (e) {
          var d = e.target.result;
          if (!d.objectStoreNames.contains('games')) d.createObjectStore('games', { keyPath: 'id', autoIncrement: true });
          if (!d.objectStoreNames.contains('tsumego')) d.createObjectStore('tsumego', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('imported')) d.createObjectStore('imported', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
        };
        req.onsuccess = function (e) { db = e.target.result; resolve(); };
        req.onerror = function () { useLS = true; resolve(); };
      } catch (e) { useLS = true; resolve(); }
    });
  }

  function lsKey(store) { return 'weiqi:' + store; }
  function lsGet(store) { try { return JSON.parse(global.localStorage.getItem(lsKey(store)) || 'null'); } catch (e) { return null; } }
  function lsSet(store, val) { try { global.localStorage.setItem(lsKey(store), JSON.stringify(val)); } catch (e) {} }

  function tx(store, mode) { return db.transaction(store, mode).objectStore(store); }
  function req2p(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function asArr(v) { return Array.isArray(v) ? v : []; }

  var Store = {
    init: open,

    add: function (store, val) {
      if (useLS) {
        var all = asArr(lsGet(store));
        if (store === 'games') val.id = (all.length ? all[all.length - 1].id : 0) + 1;
        all.push(val); lsSet(store, all); return Promise.resolve(val);
      }
      return req2p(tx(store, 'readwrite').add(val));
    },

    getAll: function (store) {
      if (useLS) return Promise.resolve(asArr(lsGet(store)));
      return req2p(tx(store, 'readonly').getAll()).then(asArr);
    },

    put: function (store, val) {
      if (useLS) { var m = lsGet(store) || {}; m[val.id] = val; lsSet(store, m); return Promise.resolve(); }
      return req2p(tx(store, 'readwrite').put(val));
    },

    get: function (store, key) {
      if (useLS) { var m = lsGet(store) || {}; return Promise.resolve(m[key] || null); }
      return req2p(tx(store, 'readonly').get(key));
    },

    // —— 便捷方法 ——
    addGame: function (rec) { return Store.add('games', rec); },
    getGames: function () { return Store.getAll('games'); },
    getTsumego: function () { return Store.getAll('tsumego').then(function (a) { var m = {}; a.forEach(function (x) { m[x.id] = x; }); return m; }); },
    setTsumego: function (id, data) { data.id = id; return Store.put('tsumego', data); },
    getImported: function () { return Store.getAll('imported'); },
    addImported: function (p) { return Store.add('imported', p); },
    getSetting: function (key) { return Store.get('settings', key).then(function (v) { return v ? v.val : null; }); },
    setSetting: function (key, val) { return Store.put('settings', { key: key, val: val }); }
  };

  global.Store = Store;
})(window);
