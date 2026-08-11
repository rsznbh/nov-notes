/**
 * app.js - Nov. | 纯本地嵌入式知识库
 *
 * 纯前端单文件实现（无 ES Modules），直接双击 index.html 即可使用
 * 包含：双存储引擎(IDB/localStorage) / Markdown渲染 / 全文搜索 / 主题切换 / UI组件
 */

(function () {
  'use strict';

  // ==================== 存储引擎（IDB 优先，localStorage 备用）====================

  const DB_NAME = 'EmbeddedNotesDB';
  const DB_VERSION = 3;
  const STORE_PREFIX = 'en_'; // localStorage 键前缀
  let storage = null; // 实际使用的存储实例

  // 统一存储接口
  var StorageAPI = {
    init: null,           // 返回 Promise
    getAllCategories: null,
    addCategory: null,
    updateCategory: null,
    updateCategoryOrder: null,
    reorderCategories: null,  // (activeId, targetId) — 把 active 移到 target 前面（同层内）
    moveCategoryUp: null,
    moveCategoryDown: null,
    deleteCategory: null,
    getNotesByCategory: null,
    getAllNotes: null,
    getNoteById: null,
    addNote: null,
    updateNote: null,
    moveNoteUp: null,
    moveNoteDown: null,
    deleteNote: null,
  };

  // ==================== IndexedDB 实现 ====================

  function createIDBStore() {
    var dbInstance = null;

    function open() {
      return new Promise(function (resolve, reject) {
        if (dbInstance) return resolve(dbInstance);
        var req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          var upgradeTx = e.target.transaction;
          if (!db.objectStoreNames.contains('categories')) {
            var cs = db.createObjectStore('categories', { keyPath: 'id', autoIncrement: true });
            cs.createIndex('name', 'name', { unique: true });
            cs.createIndex('order', 'order', { unique: false });
            cs.createIndex('parentId', 'parentId', { unique: false });
          }
          if (!db.objectStoreNames.contains('notes')) {
            var ns = db.createObjectStore('notes', { keyPath: 'id', autoIncrement: true });
            ns.createIndex('categoryId', 'categoryId', { unique: false });
            ns.createIndex('updatedAt', 'updatedAt', { unique: false });
            ns.createIndex('sortOrder', 'sortOrder', { unique: false });
          }
          if (e.oldVersion < 2 && db.objectStoreNames.contains('notes')) {
            var notesStore = upgradeTx.objectStore('notes');
            notesStore.openCursor().onsuccess = function (ev) {
              var cursor = ev.target.result;
              if (cursor) {
                var val = cursor.value;
                if (val.sortOrder === undefined || val.sortOrder === null) {
                  val.sortOrder = val.id;
                  cursor.update(val);
                }
                cursor.continue();
              }
            };
          }
          if (e.oldVersion < 3 && db.objectStoreNames.contains('categories')) {
            var catStore = upgradeTx.objectStore('categories');
            if (!catStore.indexNames.contains('parentId')) {
              catStore.createIndex('parentId', 'parentId', { unique: false });
            }
            catStore.openCursor().onsuccess = function (ev) {
              var cursor = ev.target.result;
              if (cursor) {
                var val = cursor.value;
                if (val.parentId === undefined || val.parentId === null) {
                  val.parentId = null;
                  cursor.update(val);
                }
                cursor.continue();
              }
            };
          }
        };
        req.onsuccess = function (e) { dbInstance = e.target.result; resolve(dbInstance); };
        req.onerror = function () { reject(new Error('IndexedDB open failed')); };
        req.onblocked = function () { reject(new Error('IndexedDB blocked')); };
      });
    }

    function tx(storeName, mode) {
      return dbInstance.transaction(storeName, mode).objectStore(storeName);
    }

    function getById(store, id) {
      return new Promise(function (res, rej) {
        var r = tx(store).get(id);
        r.onsuccess = function () { res(r.result || null); };
        r.onerror = function () { rej(r.error); };
      });
    }

    function put(store, data) {
      return new Promise(function (res, rej) {
        var r = tx(store, 'readwrite').put(data);
        r.onsuccess = function () { res(data.id || r.result); };
        r.onerror = function () { rej(r.error); };
      });
    }

    return {
      init: open,
      getAllCategories: function () {
        return open().then(function () {
          return new Promise(function (res, rej) {
            var r = tx('categories').getAll();
            r.onsuccess = function () { res((r.result || []).sort(function (a, b) { return (a.order || 0) - (b.order || 0); })); };
            r.onerror = function () { rej(r.error); };
          });
        });
      },
      addCategory: function (name, order, parentId) {
        return open().then(function () {
          return new Promise(function (res, rej) {
            var r = tx('categories', 'readwrite').add({ name: name, order: order || 0, parentId: parentId || null, createdAt: Date.now() });
            r.onsuccess = function () { res(r.result); };
            r.onerror = function () { rej(r.error); };
          });
        });
      },
      reorderCategories: function (activeId, targetId) {
        return open().then(function () {
          return storage.getAllCategories().then(function (cats) {
            var active = null, target = null;
            for (var i = 0; i < cats.length; i++) {
              if (cats[i].id === activeId) active = cats[i];
              if (cats[i].id === targetId) target = cats[i];
            }
            if (!active || !target) return;
            var pa = active.parentId == null ? null : active.parentId;
            var pb = target.parentId == null ? null : target.parentId;
            if (pa !== pb) return;
            var siblings = cats.filter(function (c) {
              var cp = c.parentId == null ? null : c.parentId;
              return cp === pa;
            });
            siblings.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
            var srcIdx = -1, dstIdx = -1;
            for (var j = 0; j < siblings.length; j++) {
              if (siblings[j].id === activeId) srcIdx = j;
              if (siblings[j].id === targetId) dstIdx = j;
            }
            if (srcIdx < 0 || dstIdx < 0) return;
            var item = siblings.splice(srcIdx, 1)[0];
            if (srcIdx < dstIdx) dstIdx--;
            siblings.splice(dstIdx, 0, item);
            for (var k = 0; k < siblings.length; k++) {
              siblings[k].order = k;
            }
            // 使用 put() 逐个写入，与现有代码风格一致
            return Promise.all(siblings.map(function (c) { return put('categories', c); }));
          });
        }).catch(function (err) {
          console.error('[reorder] error', err);
        });
      },
      addChildCategory: function (name, parentId) {
        return open().then(function () {
          return getById('categories', parentId).then(function (parent) {
            if (!parent) throw new Error('parent not found');
            // 获取兄弟节点数量作为 order
            return new Promise(function (res, rej) {
              var idx = tx('categories').index('parentId');
              var r = idx.getAll(IDBKeyRange.only(parentId));
              r.onsuccess = function () { res(r.result.length); };
              r.onerror = function () { rej(r.error); };
            }).then(function (count) {
              return new Promise(function (res, rej) {
                var r2 = tx('categories', 'readwrite').add({ name: name, order: count, parentId: parentId, createdAt: Date.now() });
                r2.onsuccess = function () { res(r2.result); };
                r2.onerror = function () { rej(r2.error); };
              });
            });
          });
        });
      },
      getChildrenOfCategory: function (parentId) {
        return open().then(function () {
          return new Promise(function (res, rej) {
            var idx = tx('categories').index('parentId');
            var r = idx.getAll(IDBKeyRange.only(parentId));
            r.onsuccess = function () {
              res((r.result || []).sort(function (a, b) { return (a.order || 0) - (b.order || 0); }));
            };
            r.onerror = function () { rej(r.error); };
          });
        });
      },
      getRootCategories: function () {
        return open().then(function () {
          return new Promise(function (res, rej) {
            var idx = tx('categories').index('parentId');
            var r = idx.getAll(IDBKeyRange.only(null));
            r.onsuccess = function () {
              res((r.result || []).sort(function (a, b) { return (a.order || 0) - (b.order || 0); }));
            };
            r.onerror = function () { rej(r.error); };
          });
        });
      },
      updateCategory: function (id, name) {
        return open().then(function () {
          return getById('categories', id).then(function (cat) {
            if (!cat) throw new Error('not found');
            cat.name = name;
            return put('categories', cat);
          });
        });
      },
      updateCategoryOrder: function (id, order) {
        return open().then(function () {
          return getById('categories', id).then(function (cat) {
            if (!cat) throw new Error('not found');
            cat.order = order;
            return put('categories', cat);
          });
        });
      },
      moveCategoryUp: function (id) {
        return open().then(function () {
          return storage.getAllCategories().then(function (cats) {
            var idx = cats.findIndex(function (c) { return c.id === id; });
            if (idx <= 0) return;
            var a = cats[idx - 1], b = cats[idx];
            var tmp = a.order; a.order = b.order; b.order = tmp;
            return Promise.all([put('categories', a), put('categories', b)]);
          });
        });
      },
      moveCategoryDown: function (id) {
        return open().then(function () {
          return storage.getAllCategories().then(function (cats) {
            var idx = cats.findIndex(function (c) { return c.id === id; });
            if (idx < 0 || idx >= cats.length - 1) return;
            var a = cats[idx], b = cats[idx + 1];
            var tmp = a.order; a.order = b.order; b.order = tmp;
            return Promise.all([put('categories', a), put('categories', b)]);
          });
        });
      },
      deleteCategory: function (id) {
        return open().then(function () {
          return new Promise(function (res, rej) {
            var r = tx('categories').getAll();
            r.onsuccess = function () {
              var allCats = r.result || [];
              // 递归收集所有后代分类 ID
              var toDelete = [id];
              function collect(parentId) {
                for (var i = 0; i < allCats.length; i++) {
                  if (allCats[i].parentId === parentId && toDelete.indexOf(allCats[i].id) === -1) {
                    toDelete.push(allCats[i].id);
                    collect(allCats[i].id);
                  }
                }
              }
              collect(id);

              var db = dbInstance;
              var t = db.transaction(['categories', 'notes'], 'readwrite');
              var cs = t.objectStore('categories');
              var ni = t.objectStore('notes');

              // 用 cursor 遍历并删除相关笔记（同步调用 c.delete() 在 cursor 生命周期内）
              var niIdx = ni.index('categoryId');
              var cursor = niIdx.openCursor();
              cursor.onsuccess = function () {
                var c = cursor.result;
                if (c) {
                  if (toDelete.indexOf(c.value.categoryId) !== -1) c.delete();
                  c.continue();
                }
              };

              // 用 onupgradeneeded 式的 trick：在 cursor 完成后、事务提交前删除分类
              // 更可靠的做法：单独开事务删除分类（先删笔记，再删分类）
              t.oncomplete = function () {
                // 笔记已清理完毕，另开一个事务删除分类
                var t2 = db.transaction('categories', 'readwrite');
                var cs2 = t2.objectStore('categories');
                for (var j = 0; j < toDelete.length; j++) cs2.delete(toDelete[j]);
                t2.oncomplete = function () { res(); };
                t2.onerror = function () { res(); }; // 分类删除失败也算完成（笔记已删除）
              };
              t.onerror = function () { rej(t.error); };
            };
            r.onerror = function () { rej(r.error); };
          });
        });
      },
      getNotesByCategory: function (catId) {
        return open().then(function () {
          return new Promise(function (res, rej) {
            var s = tx('notes'), idx = s.index('categoryId');
            var r = idx.getAll(IDBKeyRange.only(catId));
            r.onsuccess = function () {
              res((r.result || []).sort(function (a, b) {
                var sa = a.sortOrder != null ? a.sortOrder : a.id;
                var sb = b.sortOrder != null ? b.sortOrder : b.id;
                return sa - sb;
              }));
            };
            r.onerror = function () { rej(r.error); };
          });
        });
      },
      getAllNotes: function () {
        return open().then(function () {
          return new Promise(function (res, rej) {
            var r = tx('notes').getAll();
            r.onsuccess = function () { res((r.result || []).sort(function (a, b) { return b.updatedAt - a.updatedAt; })); };
            r.onerror = function () { rej(r.error); };
          });
        });
      },
      getNoteById: function (id) {
        return open().then(function () { return getById('notes', id); });
      },
      addNote: function (note) {
        return open().then(function () {
          return put('notes', {
            title: note.title || '无标题',
            content: note.content || '',
            categoryId: note.categoryId,
            tags: note.tags || [],
            sortOrder: note.sortOrder != null ? note.sortOrder : Date.now(),
            createdAt: Date.now(),
            updatedAt: Date.now()
          });
        });
      },
      updateNote: function (id, updates) {
        return open().then(function () {
          return getById('notes', id).then(function (note) {
            if (!note) throw new Error('not found');
            Object.assign(note, updates, { updatedAt: Date.now() });
            return put('notes', note);
          });
        });
      },
      moveNoteUp: function (id) {
        return open().then(function () {
          return getById('notes', id).then(function (note) {
            if (!note) return;
            return getNotesByCategory(note.categoryId).then(function (notes) {
              var idx = notes.findIndex(function (n) { return n.id === id; });
              if (idx <= 0) return;
              var a = notes[idx - 1], b = notes[idx];
              var tmp = a.sortOrder != null ? a.sortOrder : a.id;
              a.sortOrder = b.sortOrder != null ? b.sortOrder : b.id;
              b.sortOrder = tmp;
              return Promise.all([put('notes', a), put('notes', b)]);
            });
          });
        });
      },
      moveNoteDown: function (id) {
        return open().then(function () {
          return getById('notes', id).then(function (note) {
            if (!note) return;
            return getNotesByCategory(note.categoryId).then(function (notes) {
              var idx = notes.findIndex(function (n) { return n.id === id; });
              if (idx < 0 || idx >= notes.length - 1) return;
              var a = notes[idx], b = notes[idx + 1];
              var tmp = a.sortOrder != null ? a.sortOrder : a.id;
              a.sortOrder = b.sortOrder != null ? b.sortOrder : b.id;
              b.sortOrder = tmp;
              return Promise.all([put('notes', a), put('notes', b)]);
            });
          });
        });
      },
      deleteNote: function (id) {
        return open().then(function () {
          return new Promise(function (res, rej) {
            var r = tx('notes', 'readwrite').delete(id);
            r.onsuccess = function () { res(); };
            r.onerror = function () { rej(r.error); };
          });
        });
      }
    };
  }

  // ==================== localStorage 备用实现 ====================

  function createLocalStore() {
    // 数据结构：{ categories: [{id, name, order, createdAt}], notes: [{id, categoryId, title, content, tags, sortOrder, createdAt, updatedAt}] }
    function loadData() {
      try {
        var raw = localStorage.getItem(STORE_PREFIX + 'data');
        return raw ? JSON.parse(raw) : { categories: [], notes: [] };
      } catch (e) {
        return { categories: [], notes: [] };
      }
    }

    function saveData(data) {
      localStorage.setItem(STORE_PREFIX + 'data', JSON.stringify(data));
    }

    function nextId(arr) {
      var max = 0;
      for (var i = 0; i < arr.length; i++) if (arr[i].id > max) max = arr[i].id;
      return max + 1;
    }

    return {
      init: function () { return Promise.resolve(); },
      getAllCategories: function () {
        return Promise.resolve(loadData().categories.sort(function (a, b) { return (a.order || 0) - (b.order || 0); }));
      },
      addCategory: function (name, order, parentId) {
        var data = loadData();
        var cat = { id: nextId(data.categories), name: name, order: order || 0, parentId: parentId || null, createdAt: Date.now() };
        data.categories.push(cat);
        saveData(data);
        return Promise.resolve(cat.id);
      },
      addChildCategory: function (name, parentId) {
        var data = loadData();
        var siblings = data.categories.filter(function (c) { return c.parentId === parentId; });
        var cat = { id: nextId(data.categories), name: name, order: siblings.length, parentId: parentId, createdAt: Date.now() };
        data.categories.push(cat);
        saveData(data);
        return Promise.resolve(cat.id);
      },
      getChildrenOfCategory: function (parentId) {
        var children = loadData().categories.filter(function (c) { return c.parentId === parentId; });
        return Promise.resolve(children.sort(function (a, b) { return (a.order || 0) - (b.order || 0); }));
      },
      getRootCategories: function () {
        var roots = loadData().categories.filter(function (c) { return c.parentId === null || c.parentId === undefined; });
        return Promise.resolve(roots.sort(function (a, b) { return (a.order || 0) - (b.order || 0); }));
      },
      updateCategory: function (id, name) {
        var data = loadData();
        var cat = data.categories.find(function (c) { return c.id === id; });
        if (!cat) return Promise.reject(new Error('not found'));
        cat.name = name;
        saveData(data);
        return Promise.resolve();
      },
      updateCategoryOrder: function (id, order) {
        var data = loadData();
        var cat = data.categories.find(function (c) { return c.id === id; });
        if (!cat) return Promise.reject(new Error('not found'));
        cat.order = order;
        saveData(data);
        return Promise.resolve();
      },
      reorderCategories: function (activeId, targetId) {
        var data = loadData();
        var active = data.categories.find(function (c) { return c.id === activeId; });
        var target = data.categories.find(function (c) { return c.id === targetId; });
        if (!active || !target) return Promise.resolve();
        var pa = active.parentId == null ? null : active.parentId;
        var pb = target.parentId == null ? null : target.parentId;
        if (pa !== pb) return Promise.resolve(); // 只允许同层排序
        // 收集同层所有分类，按 order 排序
        var siblings = data.categories.filter(function (c) {
          var cp = c.parentId == null ? null : c.parentId;
          return cp === pa;
        });
        siblings.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
        var srcIdx = -1, dstIdx = -1;
        for (var j = 0; j < siblings.length; j++) {
          if (siblings[j].id === activeId) srcIdx = j;
          if (siblings[j].id === targetId) dstIdx = j;
        }
        if (srcIdx < 0 || dstIdx < 0) return Promise.resolve();
        // 把 active 从原位置移除，插入到 target 之前
        var item = siblings.splice(srcIdx, 1)[0];
        if (srcIdx < dstIdx) dstIdx--;
        siblings.splice(dstIdx, 0, item);
        // 重新分配 order 值
        for (var k = 0; k < siblings.length; k++) {
          siblings[k].order = k;
        }
        saveData(data);
        return Promise.resolve();
      },
      moveCategoryUp: function (id) {
        var data = loadData();
        var cats = data.categories.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
        var idx = cats.findIndex(function (c) { return c.id === id; });
        if (idx <= 0) return Promise.resolve();
        var tmp = cats[idx - 1].order; cats[idx - 1].order = cats[idx].order; cats[idx].order = tmp;
        saveData(data);
        return Promise.resolve();
      },
      moveCategoryDown: function (id) {
        var data = loadData();
        var cats = data.categories.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
        var idx = cats.findIndex(function (c) { return c.id === id; });
        if (idx < 0 || idx >= cats.length - 1) return Promise.resolve();
        var tmp = cats[idx].order; cats[idx].order = cats[idx + 1].order; cats[idx + 1].order = tmp;
        saveData(data);
        return Promise.resolve();
      },
      deleteCategory: function (id) {
        var data = loadData();
        // 递归收集所有后代分类 ID
        var toDelete = [id];
        function collect(parentId) {
          for (var i = 0; i < data.categories.length; i++) {
            if (data.categories[i].parentId === parentId && toDelete.indexOf(data.categories[i].id) === -1) {
              toDelete.push(data.categories[i].id);
              collect(data.categories[i].id);
            }
          }
        }
        collect(id);
        data.categories = data.categories.filter(function (c) { return toDelete.indexOf(c.id) === -1; });
        data.notes = data.notes.filter(function (n) { return toDelete.indexOf(n.categoryId) === -1; });
        saveData(data);
        return Promise.resolve();
      },
      getNotesByCategory: function (catId) {
        var notes = loadData().notes.filter(function (n) { return n.categoryId === catId; });
        return Promise.resolve(notes.sort(function (a, b) {
          var sa = a.sortOrder != null ? a.sortOrder : a.id;
          var sb = b.sortOrder != null ? b.sortOrder : b.id;
          return sa - sb;
        }));
      },
      getAllNotes: function () {
        return Promise.resolve(loadData().notes.sort(function (a, b) { return b.updatedAt - a.updatedAt; }));
      },
      getNoteById: function (id) {
        var note = loadData().notes.find(function (n) { return n.id === id; });
        return Promise.resolve(note || null);
      },
      addNote: function (note) {
        var data = loadData();
        var rec = {
          id: nextId(data.notes),
          title: note.title || '无标题',
          content: note.content || '',
          categoryId: note.categoryId,
          tags: note.tags || [],
          sortOrder: note.sortOrder != null ? note.sortOrder : Date.now(),
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        data.notes.push(rec);
        saveData(data);
        return Promise.resolve(rec.id);
      },
      updateNote: function (id, updates) {
        var data = loadData();
        var note = data.notes.find(function (n) { return n.id === id; });
        if (!note) return Promise.reject(new Error('not found'));
        Object.assign(note, updates, { updatedAt: Date.now() });
        saveData(data);
        return Promise.resolve();
      },
      moveNoteUp: function (id) {
        var data = loadData();
        var note = data.notes.find(function (n) { return n.id === id; });
        if (!note) return Promise.resolve();
        var catNotes = data.notes.filter(function (n) { return n.categoryId === note.categoryId; })
          .sort(function (a, b) { var sa = a.sortOrder != null ? a.sortOrder : a.id; var sb = b.sortOrder != null ? b.sortOrder : b.id; return sa - sb; });
        var idx = catNotes.findIndex(function (n) { return n.id === id; });
        if (idx <= 0) return Promise.resolve();
        var a = catNotes[idx - 1], b = catNotes[idx];
        var tmp = a.sortOrder != null ? a.sortOrder : a.id;
        a.sortOrder = b.sortOrder != null ? b.sortOrder : b.id;
        b.sortOrder = tmp;
        saveData(data);
        return Promise.resolve();
      },
      moveNoteDown: function (id) {
        var data = loadData();
        var note = data.notes.find(function (n) { return n.id === id; });
        if (!note) return Promise.resolve();
        var catNotes = data.notes.filter(function (n) { return n.categoryId === note.categoryId; })
          .sort(function (a, b) { var sa = a.sortOrder != null ? a.sortOrder : a.id; var sb = b.sortOrder != null ? b.sortOrder : b.id; return sa - sb; });
        var idx = catNotes.findIndex(function (n) { return n.id === id; });
        if (idx < 0 || idx >= catNotes.length - 1) return Promise.resolve();
        var a = catNotes[idx], b = catNotes[idx + 1];
        var tmp = a.sortOrder != null ? a.sortOrder : a.id;
        a.sortOrder = b.sortOrder != null ? b.sortOrder : b.id;
        b.sortOrder = tmp;
        saveData(data);
        return Promise.resolve();
      },
      deleteNote: function (id) {
        var data = loadData();
        data.notes = data.notes.filter(function (n) { return n.id !== id; });
        saveData(data);
        return Promise.resolve();
      }
    };
  }

  // 自动选择存储引擎
  function initStorage() {
    return new Promise(function (resolve) {
      // 先尝试 IndexedDB
      if (typeof indexedDB !== 'undefined') {
        var idbStore = createIDBStore();
        idbStore.init().then(function () {
          storage = idbStore;
          console.log('[Storage] Using IndexedDB');
          resolve();
        }).catch(function () {
          // IndexedDB 失败 → 降级到 localStorage
          storage = createLocalStore();
          console.log('[Storage] IndexedDB unavailable, using localStorage');
          resolve();
        });
      } else {
        // 无 IndexedDB → 直接用 localStorage
        storage = createLocalStore();
        console.log('[Storage] Using localStorage');
        resolve();
      }
    });
  }

  // ==================== 深空特效引擎 ====================

  var isMobile = false;

  // 检测移动端
  function detectMobile() {
    isMobile = window.innerWidth < 768;
    if (isMobile) {
      document.body.classList.add('disable-effects', 'disable-cursor');
    }
    return isMobile;
  }

  // 1. 星空背景 Canvas
  var starfield = null;

  function initStarfield() {
    if (detectMobile()) return;
    var canvas = document.getElementById('starfield-canvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var W, H, stars = [], nebulae = [];
    var scrollY = 0;
    var time = 0;

    function resize() {
      W = canvas.width = window.innerWidth;
      H = canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    // 生成星星（3层）
    var starCount = 300;
    for (var i = 0; i < starCount; i++) {
      var layer = i < 100 ? 0 : (i < 200 ? 1 : 2);
      var size = layer === 0 ? (0.3 + Math.random() * 0.5) : layer === 1 ? (0.6 + Math.random() * 0.8) : (1.0 + Math.random() * 1.5);
      stars.push({
        x: Math.random() * W, y: Math.random() * H,
        size: size, baseOpacity: 0.3 + Math.random() * 0.7,
        speed: 0.3 + Math.random() * 1.5, phase: Math.random() * Math.PI * 2,
        parallax: 0.01 + layer * 0.015
      });
    }

    // 星云团
    var nebulaColors = ['rgba(129,140,248,', 'rgba(99,102,241,', 'rgba(165,180,252,', 'rgba(34,211,238,'];
    for (var n = 0; n < 4; n++) {
      nebulae.push({
        x: Math.random() * W, y: Math.random() * H,
        radius: 250 + Math.random() * 350,
        color: nebulaColors[n], opacity: 0.015 + Math.random() * 0.025,
        dx: (Math.random() - 0.5) * 0.1, dy: (Math.random() - 0.5) * 0.08
      });
    }

    function render() {
      time += 0.016;
      ctx.clearRect(0, 0, W, H);

      // 中心黑洞微光
      var cx = W / 2, cy = H / 2;
      var pulse = 0.5 + 0.5 * Math.sin(time * 0.2);
      var bh = ctx.createRadialGradient(cx, cy, 0, cx, cy, 350 + pulse * 100);
      bh.addColorStop(0, 'rgba(124,111,240,' + (0.04 * pulse) + ')');
      bh.addColorStop(0.5, 'rgba(99,102,241,' + (0.02 * pulse) + ')');
      bh.addColorStop(1, 'transparent');
      ctx.fillStyle = bh;
      ctx.fillRect(0, 0, W, H);

      // 星云
      for (var n = 0; n < nebulae.length; n++) {
        var neb = nebulae[n];
        neb.x += neb.dx;
        neb.y += neb.dy;
        if (neb.x < -200) neb.x = W + 200;
        if (neb.x > W + 200) neb.x = -200;
        if (neb.y < -200) neb.y = H + 200;
        if (neb.y > H + 200) neb.y = -200;
        var grad = ctx.createRadialGradient(neb.x, neb.y + scrollY * 0.05, 0, neb.x, neb.y + scrollY * 0.05, neb.radius);
        grad.addColorStop(0, neb.color + neb.opacity + ')');
        grad.addColorStop(1, 'transparent');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
      }

      // 星星
      for (var i = 0; i < stars.length; i++) {
        var s = stars[i];
        var twinkle = s.baseOpacity * (0.5 + 0.5 * Math.sin(time * s.speed + s.phase));
        var y = s.y + scrollY * s.parallax;
        y = ((y % H) + H) % H;
        ctx.beginPath();
        ctx.arc(s.x, y, s.size, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(224,224,240,' + twinkle + ')';
        ctx.fill();
      }

      starfield.animId = requestAnimationFrame(render);
    }

    // 监听滚动
    var mainContent = document.getElementById('main-content');
    if (mainContent) {
      mainContent.addEventListener('scroll', function () {
        scrollY = mainContent.scrollTop;
      });
    }

    starfield = { canvas: canvas, ctx: ctx, resize: resize, animId: null };
    render();
  }

  // 2. 自定义鼠标光标
  function initCursor() {
    if (isMobile) return;
    var dot = document.getElementById('cursor-dot');
    if (!dot) return;

    var mouseX = -100, mouseY = -100;
    var show = false;

    // 隐藏原生光标
    document.body.style.cursor = 'none';

    var hoverTargets = 'a, button, .category-header, .note-item, .category-card, .recent-note-item, .header-btn, .logo, .sidebar-add-btn, .cat-action-btn, .note-action-btn, .editor-btn, .empty-state-btn, .search-result-item, .copy-btn, .drag-handle, .code-block, .sidebar-toggle, .note-item-add';

    var throttleTimer = 0;
    document.addEventListener('mousemove', function (e) {
      var now = Date.now();
      if (now - throttleTimer < 16) return;
      throttleTimer = now;
      mouseX = e.clientX;
      mouseY = e.clientY;
      if (!show) {
        show = true;
        dot.style.opacity = '1';
      }
      dot.style.left = mouseX + 'px';
      dot.style.top = mouseY + 'px';
    });

    // Hover 效果
    document.addEventListener('mouseover', function (e) {
      var t = e.target.closest(hoverTargets);
      if (t) {
        dot.classList.add('hover');
      }
    });
    document.addEventListener('mouseout', function (e) {
      var t = e.target.closest(hoverTargets);
      if (t) {
        dot.classList.remove('hover');
      }
    });

    document.addEventListener('mouseleave', function () {
      dot.style.opacity = '0';
    });
    document.addEventListener('mouseenter', function () {
      dot.style.opacity = '1';
    });
  }

  // 3. 鼠标粒子拖尾 Canvas
  var particleCanvas = null;

  function initParticles() {
    if (isMobile) return;
    var canvas = document.getElementById('particle-canvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var W, H, particles = [];
    var mouseX = -100, mouseY = -100;
    var lastSpawn = 0;
    var colors = ['rgba(124,111,240,', 'rgba(99,102,241,', 'rgba(167,139,250,', 'rgba(34,211,238,'];
    var MAX_PARTICLES = 50;

    function resize() {
      W = canvas.width = window.innerWidth;
      H = canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    var throttleTimer = 0;
    document.addEventListener('mousemove', function (e) {
      var now = Date.now();
      if (now - throttleTimer < 20) return;
      throttleTimer = now;
      mouseX = e.clientX;
      mouseY = e.clientY;

      // 生成粒子
      var count = 1 + Math.floor(Math.random() * 2);
      for (var i = 0; i < count; i++) {
        if (particles.length >= MAX_PARTICLES) break;
        particles.push({
          x: mouseX + (Math.random() - 0.5) * 6,
          y: mouseY + (Math.random() - 0.5) * 6,
          vx: (Math.random() - 0.5) * 0.6,
          vy: (Math.random() - 0.5) * 0.6 - 0.15,
          size: 1.5 + Math.random() * 2.5,
          life: 1.0,
          decay: 0.008 + Math.random() * 0.012,
          color: colors[Math.floor(Math.random() * colors.length)]
        });
      }
    });

    function render() {
      ctx.clearRect(0, 0, W, H);

      for (var i = particles.length - 1; i >= 0; i--) {
        var p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life -= p.decay;
        p.size *= 0.995;

        if (p.life <= 0 || p.size < 0.3) {
          particles.splice(i, 1);
          continue;
        }

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.color + p.life + ')';
        ctx.fill();
      }

      requestAnimationFrame(render);
    }

    render();
    particleCanvas = { canvas: canvas, ctx: ctx, resize: resize };
  }

  // ==================== 桌宠 — 像素小螃蟹 ====================

  var petState = { idle: true, dragging: false, dragOffX: 0, dragOffY: 0, petX: 0, petY: 0, speechTimer: null, mood: 'happy', menuOpen: false, bubbleTimer: null, walkDir: 1 };

  function initPet() {
    if (isMobile) return;
    var pet = document.getElementById('pet');
    if (!pet) return;
    var speech = document.getElementById('pet-speech');
    var pupilL = document.querySelector('.pet-pupil-l');
    var pupilR = document.querySelector('.pet-pupil-r');
    var mouth = document.getElementById('pet-mouth');
    var bubble = document.getElementById('bubble');

    // 眼睛跟随鼠标
    document.addEventListener('mousemove', function (e) {
      if (!pupilL || !pupilR) return;
      var rect = pet.getBoundingClientRect();
      // SVG viewBox 到 CSS 像素的缩放比
      var svgW = 132, svgH = 114;
      var sx = rect.width / svgW, sy = rect.height / svgH;
      // 眼睛中心在 viewBox 中的坐标
      var eyeLCX = 52, eyeLCY = 39;
      var eyeRCX = 79, eyeRCY = 39;
      var maxD = 1.5; // viewBox 单位，最大偏移量（眼睛半径6 - 瞳孔半径4 = 2）
      var sens = 0.02; // 灵敏度

      function track(eyeCX, eyeCY, pupil) {
        var cx = rect.left + eyeCX * sx;
        var cy = rect.top + eyeCY * sy;
        var dx = e.clientX - cx;
        var dy = e.clientY - cy;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var mx = dist > 0 ? (dx / dist) * Math.min(maxD, dist * sx * sens) : 0;
        var my = dist > 0 ? (dy / dist) * Math.min(maxD, dist * sy * sens) : 0;
        pupil.setAttribute('cx', (eyeCX + mx).toFixed(1));
        pupil.setAttribute('cy', (eyeCY + my).toFixed(1));
      }
      track(eyeLCX, eyeLCY, pupilL);
      track(eyeRCX, eyeRCY, pupilR);
    });

    // 拖拽
    var dragging = false, dragOffX = 0, dragOffY = 0;
    pet.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      dragging = true;
      var rect = pet.getBoundingClientRect();
      dragOffX = e.clientX - rect.left;
      dragOffY = e.clientY - rect.top;
      pet.classList.remove('pet-idle');
      pet.style.transition = 'none';
      // 钳子举起动画
      var clawL = pet.querySelector('.claw-left');
      var clawR = pet.querySelector('.claw-right');
      if (clawL) clawL.style.animation = 'none';
      if (clawR) clawR.style.animation = 'none';
      // 张大嘴
      if (mouth) mouth.setAttribute('d', 'M58 58 Q66 68 74 58');
    });

    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var newX = e.clientX - dragOffX;
      var newY = e.clientY - dragOffY;
      newX = Math.max(0, Math.min(window.innerWidth - 106, newX));
      newY = Math.max(0, Math.min(window.innerHeight - 91, newY));
      pet.style.left = newX + 'px';
      pet.style.top = newY + 'px';
      pet.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      pet.style.transition = '';
      // 恢复微笑
      if (mouth) mouth.setAttribute('d', 'M61 60 Q66 64 71 60');
      // 恢复钳子动画
      var clawL = pet.querySelector('.claw-left');
      var clawR = pet.querySelector('.claw-right');
      if (clawL) clawL.style.animation = '';
      if (clawR) clawR.style.animation = '';
      // 恢复空闲动画
      setTimeout(function () { pet.classList.add('pet-idle'); }, 800);
    });

    // 右键菜单
    var menu = null;
    pet.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      menu = document.createElement('div');
      menu.id = 'pet-menu';
      var moodLabel = { happy: '开心', sleepy: '困了', hungry: '饿了', curious: '好奇', busy: '忙碌' }[petState.mood];
      menu.innerHTML = '<div style="background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:8px;padding:4px;font-size:12px;color:var(--text-primary);box-shadow:0 4px 16px rgba(0,0,0,0.2);min-width:120px">' +
        '<div class="pet-menu-item" data-action="feed">🦐 喂食小鱼</div>' +
        '<div class="pet-menu-item" data-action="skin">🎨 换皮肤</div>' +
        '<div class="pet-menu-item" data-action="sleep">💤 休眠</div>' +
        '<div class="pet-menu-item" data-action="exit">❌ 退出</div>' +
        '<div style="border-top:1px solid var(--border-color);margin:4px 0;padding:4px 8px 2px;font-size:10px;color:var(--text-muted)">情绪: ' + moodLabel + '</div>' +
        '</div>';
      var mx = e.clientX, my = e.clientY;
      menu.style.position = 'fixed';
      menu.style.left = mx + 'px';
      menu.style.top = my + 'px';
      menu.style.zIndex = '9999';
      document.body.appendChild(menu);
      petState.menuOpen = true;

      // 菜单项点击
      menu.querySelectorAll('.pet-menu-item').forEach(function (item) {
        item.style.padding = '6px 10px';
        item.style.borderRadius = '4px';
        item.style.cursor = 'pointer';
        item.addEventListener('mouseenter', function () { item.style.background = 'var(--bg-hover)'; });
        item.addEventListener('mouseleave', function () { item.style.background = ''; });
        item.addEventListener('click', function (action) {
          var act = item.dataset.action;
          if (act === 'feed') {
            petState.mood = 'happy';
            showSpeech('好吃！🦐');
            showBubble();
          } else if (act === 'skin') {
            cycleSkin();
            showSpeech('新衣服！✨');
          } else if (act === 'sleep') {
            petState.mood = 'sleepy';
            showSpeech('Zzz... 💤');
            pet.classList.add('pet-sleeping');
            setTimeout(function () { pet.classList.remove('pet-sleeping'); showSpeech('醒了！'); }, 3000);
          } else if (act === 'exit') {
            pet.style.display = 'none';
          }
          closeMenu();
        });
      });
    });

    function closeMenu() {
      if (menu && menu.parentNode) {
        menu.parentNode.removeChild(menu);
        menu = null;
      }
      petState.menuOpen = false;
    }
    document.addEventListener('click', closeMenu);

    // 换皮肤
    var skins = [
      { shell: '#8BB8E8', shellLight: '#A5CFF0', name: '浅蓝' },
      { shell: '#F5D5D0', shellLight: '#FAE8E8', name: '珊瑚' },
      { shell: '#D4B8F0', shellLight: '#E8D0FA', name: '淡紫' },
      { shell: '#F5E6C8', shellLight: '#FAF0E0', name: '奶油' },
      { shell: '#B8E8D4', shellLight: '#D0FAE8', name: '薄荷' },
    ];
    var currentSkin = 0;
    function cycleSkin() {
      currentSkin = (currentSkin + 1) % skins.length;
      var s = skins[currentSkin];
      // 更新壳颜色
      var rects = pet.querySelectorAll('rect');
      rects.forEach(function (r) {
        if (r.getAttribute('fill') === '#8BB8E8') r.setAttribute('fill', s.shell);
        if (r.getAttribute('fill') === '#A5CFF0') r.setAttribute('fill', s.shellLight);
      });
      var circles = pet.querySelectorAll('circle');
      circles.forEach(function (c) {
        if (c.getAttribute('fill') === '#8BB8E8') c.setAttribute('fill', s.shell);
        if (c.getAttribute('fill') === '#A5CFF0') c.setAttribute('fill', s.shellLight);
      });
    }

    // 吐泡泡
    function showBubble() {
      if (bubble) {
        bubble.style.opacity = '0.7';
        bubble.classList.add('bubble');
        setTimeout(function () {
          bubble.classList.remove('bubble');
          bubble.style.opacity = '0';
        }, 3000);
      }
    }

    // 说话
    function showSpeech(msg) {
      speech.textContent = msg;
      speech.classList.add('show');
      clearTimeout(petState.speechTimer);
      petState.speechTimer = setTimeout(function () {
        speech.classList.remove('show');
      }, 2500);
    }

    // 双击说话
    pet.addEventListener('dblclick', function (e) {
      e.preventDefault();
      var phrases = [
        '今天也在认真记笔记呢！',
        '嵌入式开发加油 💪',
        '记得保存笔记哦～',
        'HAL_GPIO_WritePin!',
        'FreeRTOS 真好用',
        'STM32 启动！',
        '代码写完了吗？',
        'Debug 辛苦了！',
        'I2C 又卡住了？',
        '烧录成功了吗？',
        '寄存器配置好了吗？',
        '别忘了看数据手册～',
        'JTAG 连接上了吗？',
        '中断向量表对齐了吗？'
      ];
      var msg = phrases[Math.floor(Math.random() * phrases.length)];
      showSpeech(msg);
      if (mouth) mouth.setAttribute('d', 'M58 58 Q66 68 74 58');
      setTimeout(function () { if (mouth) mouth.setAttribute('d', 'M61 60 Q66 64 71 60'); }, 2500);
    });

    // 随机小事件 — 吐泡泡 / 发现小鱼 / 捡到零件
    petState.bubbleTimer = setInterval(function () {
      if (petState.dragging || petState.menuOpen) return;
      var rand = Math.random();
      if (rand < 0.3) {
        showBubble();
      } else if (rand < 0.5) {
        var events = ['发现了小鱼 🐟', '捡到电子零件 🔩', '打了个哈欠 ', '伸个懒腰～', '看看谁在写代码 👀'];
        showSpeech(events[Math.floor(Math.random() * events.length)]);
      }
    }, 8000);

    // 初始位置左下角
    pet.classList.add('pet-idle');
  }

  // ==================== 搜索引擎 ====================

  var searchIndex = [];

  function rebuildSearchIndex(notes) {
    searchIndex = notes.map(function (n) {
      return {
        id: n.id, title: n.title, content: n.content,
        categoryId: n.categoryId, tags: n.tags || [],
        _tl: n.title.toLowerCase(), _cl: n.content.toLowerCase()
      };
    });
  }

  function searchNotes(query) {
    if (!query || query.trim().length < 1) return [];
    var q = query.toLowerCase().trim();
    var keywords = q.split(/\s+/);
    var results = [];
    for (var i = 0; i < searchIndex.length; i++) {
      var note = searchIndex[i], score = 0, matched = false;
      for (var k = 0; k < keywords.length; k++) {
        var kw = keywords[k];
        if (note._tl.indexOf(kw) !== -1) { score += 10; matched = true; }
        if (note._cl.indexOf(kw) !== -1) { score += 1; matched = true; }
        if (note.tags.some(function (t) { return t.toLowerCase().indexOf(kw) !== -1; })) { score += 5; matched = true; }
      }
      if (matched) results.push({ id: note.id, title: note.title, categoryId: note.categoryId, score: score, excerpt: buildExcerpt(note.content, keywords[0]) });
    }
    return results.sort(function (a, b) { return b.score - a.score; });
  }

  function buildExcerpt(content, keyword) {
    var idx = content.toLowerCase().indexOf(keyword);
    if (idx === -1) return escHtml(content.slice(0, 100)).replace(/\n/g, ' ');
    var start = Math.max(0, idx - 30), end = Math.min(content.length, idx + keyword.length + 70);
    var ex = escHtml(content.slice(start, end)).replace(/\n/g, ' ');
    if (start > 0) ex = '...' + ex;
    if (end < content.length) ex += '...';
    // 在已转义的内容上定位关键词，包裹 <mark>（注意 escHtml 后原 keyword 位置不变）
    var ki = ex.toLowerCase().indexOf(keyword);
    if (ki !== -1) ex = ex.slice(0, ki) + '<mark>' + ex.slice(ki, ki + keyword.length) + '</mark>' + ex.slice(ki + keyword.length);
    return ex;
  }

  // ==================== Markdown 渲染器 ====================

  var LOG_COLORS = {
    'ERROR': '#ef4444', 'ERR': '#ef4444', 'FATAL': '#dc2626',
    'WARN': '#f59e0b', 'WARNING': '#f59e0b',
    'INFO': '#22c55e', 'DEBUG': '#3b82f6', 'DBG': '#3b82f6',
    'HAL_': '#c084fc', 'LL_': '#c084fc', 'GPIO': '#c084fc', 'UART': '#c084fc',
    'SPI': '#c084fc', 'I2C': '#c084fc', 'DMA': '#c084fc', 'ADC': '#c084fc',
    'RCC': '#c084fc', 'NVIC': '#c084fc', 'TIM': '#c084fc', 'EXTI': '#c084fc',
    'RCC_': '#c084fc', 'GPIO_': '#c084fc', 'USART': '#c084fc',
    'OK': '#22c55e', 'PASS': '#22c55e', 'FAIL': '#ef4444', 'TIMEOUT': '#ef4444',
    'BUSY': '#f59e0b', 'RESET': '#f59e0b', 'SET': '#22c55e',
    'ENABLE': '#22c55e', 'DISABLE': '#ef4444'
  };

  var LANG_MAP = { c:'c', cpp:'cpp', 'c++':'cpp', cxx:'cpp', asm:'asm', assembly:'asm',
    py:'python', python3:'python', sh:'shell', bash:'shell', zsh:'shell',
    txt:'plaintext', log:'log', text:'plaintext', json:'json', yaml:'yaml',
    yml:'yaml', md:'markdown', markdown:'markdown' };

  function escHtml(t) { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function highlightCode(code, lang) {
    lang = (LANG_MAP[(lang || '').toLowerCase()] || lang || '').toLowerCase();
    if (lang === 'log') return highlightLog(code);

    var ph = [];
    var safe = code
      .replace(/("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, function (m) { var i = ph.length; ph.push('<span class="str">' + escHtml(m) + '</span>'); return '\x00PH' + i + '\x00'; })
      .replace(/(\/\/.*$|\/\*[\s\S]*?\*\/|#.*$|@.*$)/gm, function (m) { var i = ph.length; ph.push('<span class="cmt">' + escHtml(m) + '</span>'); return '\x00PC' + i + '\x00'; });

    var html = escHtml(safe);

    if (lang === 'c' || lang === 'cpp') {
      html = html.replace(/\b(void|int|char|short|long|float|double|unsigned|signed|const|volatile|static|extern|struct|typedef|enum|union|return|if|else|for|while|do|switch|case|break|continue|default|sizeof|include|define|ifdef|ifndef|endif|pragma|inline|register|auto|restrict|_Bool|uint8_t|uint16_t|uint32_t|uint64_t|int8_t|int16_t|int32_t|int64_t|size_t|bool|true|false|NULL|HAL_|LL_|GPIO_|UART_|USART_|SPI_|I2C_|DMA_|ADC_|RCC_|TIM_|EXTI_|NVIC_)\b/g, '<span class="kw">$1</span>');
      html = html.replace(/(#include|#define|#ifdef|#ifndef|#endif|#pragma|#if|#else|__attribute__)/g, '<span class="preproc">$1</span>');
      html = html.replace(/\b(0x[0-9a-fA-F]+|\d+\.?\d*f?)\b/g, '<span class="num">$1</span>');
    }
    if (lang === 'asm') {
      html = html.replace(/\b(ADD|SUB|MUL|DIV|MOV|PUSH|POP|LDR|STR|BL|BX|B|BEQ|BNE|CMP|AND|ORR|EOR|NOP|WFI|WFE|CPSID|CPSIE|DMB|DSB|ISB|MRS|MSR|LDMIA|STMIA|RFE|SVC|BKPT|\.global|\.text|\.data|\.bss|\.word|\.byte|\.short|\.ascii|\.asciz|\.thumb|\.arm|\.type|\.size|\.equ|\.set|\.macro|\.endm)\b/gi, '<span class="kw">$1</span>');
      html = html.replace(/(0x[0-9a-fA-F]+)/g, '<span class="num">$1</span>');
      html = html.replace(/(#[0-9]+)/g, '<span class="num">$1</span>');
      html = html.replace(/\b(r[0-9]|r1[0-3]|sp|lr|pc|fp|ip|cpsr|spsr)\b/gi, '<span class="reg">$1</span>');
    }
    if (lang === 'python') {
      html = html.replace(/\b(def|class|import|from|return|if|elif|else|for|while|try|except|finally|with|as|yield|lambda|pass|break|continue|raise|assert|del|in|is|not|and|or|True|False|None|self|print|range|len|str|int|float|list|dict|set|tuple|open|map|filter|zip|enumerate|super|property|staticmethod|classmethod)\b/g, '<span class="kw">$1</span>');
    }
    if (lang === 'shell') {
      html = html.replace(/\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|echo|cd|ls|mkdir|rm|cp|mv|cat|grep|sed|awk|find|chmod|chown|sudo|make|gcc|gdb|objdump|nm|size|readelf|openocd|st-flash|st-link|JLink|python3|pip)\b/g, '<span class="kw">$1</span>');
      html = html.replace(/(\$[A-Za-z_][A-Za-z0-9_]*)/g, '<span class="var">$1</span>');
    }
    for (var i = 0; i < ph.length; i++) {
      html = html.split('\x00PH' + i + '\x00').join(ph[i]);
      html = html.split('\x00PC' + i + '\x00').join(ph[i]);
    }
    return html;
  }

  function highlightLog(code) {
    return code.split('\n').map(function (line) {
      var e = escHtml(line);
      for (var kw in LOG_COLORS) {
        if (LOG_COLORS.hasOwnProperty(kw)) {
          var re = new RegExp('\\b(' + kw.replace(/_/g, '_') + ')\\b', 'g');
          e = e.replace(re, '<span style="color:' + LOG_COLORS[kw] + ';font-weight:600">' + kw + '</span>');
        }
      }
      return e;
    }).join('\n');
  }

  function slugify(t) { return t.toLowerCase().replace(/[^\w一-鿿\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim(); }

  function inlineFormat(text) {
    text = text.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
    text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="md-img" loading="lazy">');
    text = text.replace(/\[([^\]]+)\]\(#([^)]+)\)/g, '<a href="#$2" class="md-link internal-link">$1</a>');
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="md-link" target="_blank" rel="noopener">$1</a>');
    return text;
  }

  function renderMarkdown(md) {
    if (!md) return '<p style="color:var(--text-muted)">暂无内容</p>';
    var lines = md.split('\n'), out = [];
    var inCode = false, codeLang = '', codeBuf = [];
    var inTable = false, tblLines = [];
    var inList = false, listItems = [], listType = '';
    var inBq = false, bqLines = [];
    var pBuf = [];

    function flushP() { if (pBuf.length) { out.push('<p>' + inlineFormat(pBuf.join(' ')) + '</p>'); pBuf = []; } }
    function flushList() {
      if (!listItems.length) return;
      var tag = listType === 'ol' ? 'ol' : 'ul';
      out.push('<' + tag + '>' + listItems.map(function (li) { return '<li>' + inlineFormat(li) + '</li>'; }).join('') + '</' + tag + '>');
      listItems = []; inList = false; listType = '';
    }
    function flushBq() {
      if (!bqLines.length) return;
      out.push('<blockquote>' + renderMarkdown(bqLines.join('\n')) + '</blockquote>');
      bqLines = []; inBq = false;
    }
    function flushTable() {
      if (!tblLines.length) return;
      var rows = [];
      for (var i = 0; i < tblLines.length; i++) {
        var m = tblLines[i].match(/^\|(.+)\|$/);
        if (m && !m[1].match(/^[\s:-]+-[\s:-|]*$/)) rows.push(m[1].split('|'));
      }
      if (rows.length < 1) { tblLines = []; inTable = false; return; }
      var th = '<table class="md-table"><thead><tr>';
      rows[0].forEach(function (c) { th += '<th>' + inlineFormat(c.trim()) + '</th>'; });
      th += '</tr></thead><tbody>';
      for (var r = 1; r < rows.length; r++) {
        th += '<tr>';
        rows[r].forEach(function (c) { th += '<td>' + inlineFormat(c.trim()) + '</td>'; });
        th += '</tr>';
      }
      th += '</tbody></table>';
      out.push(th);
      tblLines = []; inTable = false;
    }
    function flushCode() {
      if (!codeBuf.length) { codeBuf = []; inCode = false; return; }
      var hl = highlightCode(codeBuf.join('\n'), codeLang);
      var cls = hl.split('\n');
      var numbered = cls.map(function (ln, i) {
        return '<div class="code-line"><span class="line-number">' + (i + 1) + '</span><span class="code-content">' + (ln || ' ') + '</span></div>';
      }).join('');
      out.push('<div class="code-block"><div class="code-header"><span class="code-lang">' + escHtml(codeLang || 'plaintext') + '</span><button class="copy-btn" onclick="copyCode(this)">复制</button></div><pre class="code-body">' + numbered + '</pre></div>');
      codeBuf = []; inCode = false;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.trimStart().startsWith('```')) {
        if (inCode) flushCode();
        else { flushP(); flushList(); flushBq(); flushTable(); inCode = true; codeLang = line.trimStart().slice(3).trim(); }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }

      var tm = line.match(/^\|(.+)\|$/);
      if (tm) { flushP(); flushList(); flushBq(); inTable = true; tblLines.push(line); continue; }
      if (inTable && line.match(/^\|[\s:-]+-\|/)) { tblLines.push(line); continue; }
      if (inTable) flushTable();

      if (line.trim() === '') { flushP(); flushList(); flushBq(); continue; }

      var hm = line.match(/^(#{1,6})\s+(.+)/);
      if (hm) { flushP(); flushList(); flushBq();
        var lv = hm[1].length, txt = hm[2].trim(), sl = slugify(txt);
        out.push('<h' + lv + ' id="' + sl + '"><a href="#' + sl + '" class="heading-anchor">#</a>' + inlineFormat(txt) + '</h' + lv + '>');
        continue;
      }
      if (line.match(/^(-{3,}|\*{3,}|_{3,})$/)) { flushP(); flushList(); flushBq(); out.push('<hr>'); continue; }

      var ulm = line.match(/^(\s*)[-*+]\s+(.+)/);
      var olm = line.match(/^(\s*)\d+\.\s+(.+)/);
      if (ulm || olm) {
        flushP(); flushBq();
        var mt = ulm || olm, nt = ulm ? 'ul' : 'ol';
        if (!inList || listType !== nt) { flushList(); listType = nt; inList = true; }
        listItems.push(mt[2]); continue;
      } else if (inList) flushList();

      if (line.match(/^>\s?/)) { flushP(); flushList(); inBq = true; bqLines.push(line.replace(/^>\s?/, '')); continue; }
      else if (inBq) flushBq();

      var im = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (im) { flushP(); out.push('<figure class="md-figure"><img src="' + escHtml(im[2]) + '" alt="' + escHtml(im[1]) + '" loading="lazy"><figcaption>' + escHtml(im[1]) + '</figcaption></figure>'); continue; }

      pBuf.push(line);
    }
    if (inCode) flushCode(); if (inTable) flushTable(); flushP(); flushList(); flushBq();
    return out.join('\n');
  }

  window.copyCode = function (btn) {
    var block = btn.closest('.code-block');
    var contents = block.querySelectorAll('.code-content');
    var text = '';
    for (var i = 0; i < contents.length; i++) text += contents[i].textContent + (i < contents.length - 1 ? '\n' : '');
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () { btn.textContent = '已复制 ✓'; setTimeout(function () { btn.textContent = '复制'; }, 1500); });
    }
  };

  // ==================== 主题 ====================

  var THEME_KEY = 'nov-theme';

  function initTheme() {
    var saved = localStorage.getItem(THEME_KEY);
    if (saved) setTheme(saved);
    else setTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }

  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme') || 'dark';
    setTheme(cur === 'dark' ? 'light' : 'dark');
    localStorage.setItem(THEME_KEY, cur === 'dark' ? 'light' : 'dark');
  }

  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    var btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.innerHTML = t === 'dark'
        ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
      btn.title = t === 'dark' ? '切换亮色模式' : '切换暗色模式';
    }
  }

  // ==================== 状态管理 ====================

  var expandedCats = new Set();
  var activeCatId = null;
  var activeNoteId = null;
  var currentView = 'home';
  var catsArr = []; // 缓存分类数据
  var editorMode = false; // 是否处于编辑模式
  var editingNote = null; // 当前正在编辑的笔记
  var editorSavedCatId = null; // 编辑器中的默认分类
  var cleanupInlineEditor = null; // 清理函数

  // ==================== 工具函数 ====================

  function formatDate(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function formatFullDate(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // ==================== 侧边栏渲染（树形目录） ====================

  // 递归统计分类下笔记总数（含子目录）
  function countNotesRecursive(catId, byParentMap, catNotesMap) {
    var count = (catNotesMap[catId] || []).length;
    var children = byParentMap[catId] || [];
    for (var i = 0; i < children.length; i++) {
      count += countNotesRecursive(children[i].id, byParentMap, catNotesMap);
    }
    return count;
  }

  // 递归渲染一个分类节点
  function renderCategoryNode(cat, depth, byParentMap, catNotesMap) {
    var notes = catNotesMap[cat.id] || [];
    var expanded = expandedCats.has(cat.id);
    var isActive = activeCatId === cat.id;
    var children = byParentMap[cat.id] || [];
    var totalCount = countNotesRecursive(cat.id, byParentMap, catNotesMap);
    var indent = depth * 14;

    var html = '<div class="category-item" data-cat-id="' + cat.id + '" draggable="true">' +
      '<div class="category-header' + (isActive ? ' active' : '') + '" data-cat-id="' + cat.id + '" style="padding-left:' + (12 + indent) + 'px">' +
      '<span class="drag-handle" data-drag-cat="' + cat.id + '" title="拖动排序">☰</span>' +
      '<span class="category-icon' + (expanded ? ' expanded' : '') + '">▶</span>' +
      '<span class="category-name">' + escHtml(cat.name) + '</span>' +
      '<span class="category-count">(' + totalCount + ')</span>' +
      '<div class="category-actions">' +
      '<button class="cat-action-btn btn-add-subcat" data-cat-id="' + cat.id + '" title="新增子目录">+</button>' +
      '<button class="cat-action-btn btn-rename-cat" data-cat-id="' + cat.id + '" title="重命名">✎</button>' +
      '<button class="cat-action-btn btn-delete-cat" data-cat-id="' + cat.id + '" title="删除分类">✕</button>' +
      '</div></div>' +
      '<div class="category-notes' + (expanded ? ' open' : '') + '">';

    if (expanded) {
      // 先渲染子目录
      for (var i = 0; i < children.length; i++) {
        html += renderCategoryNode(children[i], depth + 1, byParentMap, catNotesMap);
      }
      // 再渲染本分类下的笔记
      for (var j = 0; j < notes.length; j++) {
        html += '<div class="note-item' + (notes[j].id === activeNoteId ? ' active' : '') + '" data-note-id="' + notes[j].id + '" draggable="true" style="padding-left:' + (12 + indent + 16) + 'px">' +
          '<span class="drag-handle" draggable="true" data-drag-note="' + notes[j].id + '" title="拖动排序或移动">☰</span>' +
          '<span class="note-item-title">' + escHtml(notes[j].title) + '</span>' +
          '<span class="note-date">' + formatDate(notes[j].updatedAt) + '</span>' +
          '<span class="note-item-actions">' +
          '<button class="note-action-btn btn-delete-note-inline" data-note-id="' + notes[j].id + '" title="删除">✕</button>' +
          '</span></div>';
      }
      html += '<div class="note-item note-item-add" data-cat-add="' + cat.id + '" draggable="false" style="color:var(--accent);opacity:.6;padding-left:' + (12 + indent + 16) + 'px">+ 新建笔记</div>';
    }

    html += '</div></div>';
    return html;
  }

  async function renderSidebar() {
    var cats = await storage.getAllCategories();
    catsArr = cats;

    // 按 parentId 分组构建树索引
    var byParentMap = {};
    var roots = [];
    for (var i = 0; i < cats.length; i++) {
      var pid = (cats[i].parentId === undefined) ? null : cats[i].parentId;
      if (pid === null) {
        roots.push(cats[i]);
      } else {
        if (!byParentMap[pid]) byParentMap[pid] = [];
        byParentMap[pid].push(cats[i]);
      }
    }
    // 所有层级都按 order 排序
    roots.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    for (var key in byParentMap) {
      byParentMap[key].sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    }

    // 拉取所有笔记，按 categoryId 分组
    var allNotes = await storage.getAllNotes();
    var catNotesMap = {};
    for (var n = 0; n < allNotes.length; n++) {
      var cid = allNotes[n].categoryId;
      if (!catNotesMap[cid]) catNotesMap[cid] = [];
      catNotesMap[cid].push(allNotes[n]);
    }
    // 每个分类内按 sortOrder 排序
    for (var ck in catNotesMap) {
      catNotesMap[ck].sort(function (a, b) {
        var sa = a.sortOrder != null ? a.sortOrder : a.id;
        var sb = b.sortOrder != null ? b.sortOrder : b.id;
        return sa - sb;
      });
    }

    var container = document.getElementById('sidebar-content');
    var html = '';

    for (var r = 0; r < roots.length; r++) {
      html += renderCategoryNode(roots[r], 0, byParentMap, catNotesMap);
    }

    container.innerHTML = html;
  }

  // ==================== 视图渲染 ====================

  async function renderHome() {
    var cats = await storage.getAllCategories();
    var notes = await storage.getAllNotes();
    var recent = notes.slice(0, 8);
    var mc = document.getElementById('main-content');

    var html = '<div class="home-view">' +
      '<h1 class="home-title">📓 Nov.</h1>' +
      '<p class="home-subtitle">Make it work, Make it right, Make it fast.</p>' +
      '<p class="home-subtitle-attribution">—— Kent Beck</p>' +
      '<div class="home-section"><h2 class="home-section-title">分类入口</h2><div class="category-grid">';

    // 首页「分类入口」只显示根分类（一级目录），点击进入后可看到下级子目录
    var roots = cats.filter(function (c) { return c.parentId === null || c.parentId === undefined; });
    roots.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    for (var i = 0; i < roots.length; i++) {
      var cnt = notes.filter(function (n) { return n.categoryId === roots[i].id; }).length;
      var subCnt = cats.filter(function (c) { return c.parentId === roots[i].id; }).length;
      var info = cnt + ' 篇笔记';
      if (subCnt > 0) info += ' · ' + subCnt + ' 个子目录';
      html += '<div class="category-card" data-home-cat="' + roots[i].id + '">' +
        '<div class="category-card-title">' + escHtml(roots[i].name) + '</div>' +
        '<div class="category-card-count">' + info + '</div></div>';
    }
    html += '</div></div><div class="home-section"><h2 class="home-section-title">最近更新</h2>';

    if (recent.length > 0) {
      html += '<ul class="recent-notes-list">';
      for (var j = 0; j < recent.length; j++) {
        html += '<li class="recent-note-item" data-home-note="' + recent[j].id + '">' +
          '<span class="recent-note-title">' + escHtml(recent[j].title) + '</span>' +
          '<span class="recent-note-date">' + formatFullDate(recent[j].updatedAt) + '</span></li>';
      }
      html += '</ul>';
    } else {
      html += '<div class="empty-state"><div class="empty-state-icon">📝</div>' +
        '<div class="empty-state-text">还没有笔记，开始记录你的第一篇笔记吧！</div>' +
        '<button class="empty-state-btn" id="home-new-note">新建笔记</button></div>';
    }
    html += '</div></div>';
    mc.innerHTML = html;

    mc.querySelectorAll('.category-card').forEach(function (el) {
      el.addEventListener('click', function () { navigateTo(parseInt(el.dataset.homeCat)); });
    });
    mc.querySelectorAll('.recent-note-item').forEach(function (el) {
      el.addEventListener('click', function () { openNote(parseInt(el.dataset.homeNote)); });
    });
    var nb = document.getElementById('home-new-note');
    if (nb) nb.addEventListener('click', function () { openEditor(); });
  }

  async function renderNoteView(noteId, keyword) {
    var note = await storage.getNoteById(noteId);
    if (!note) {
      document.getElementById('main-content').innerHTML = '<div class="empty-state"><div class="empty-state-icon">📄</div><div class="empty-state-text">笔记不存在或已被删除</div></div>';
      return;
    }
    var cats = await storage.getAllCategories();
    var cat = cats.find(function (c) { return c.id === note.categoryId; });
    var catName = cat ? cat.name : '未分类';
    var mc = document.getElementById('main-content');

    mc.innerHTML = '<div class="note-view">' +
      '<div class="note-header">' +
      '<h1 class="note-title">' + escHtml(note.title) + '</h1>' +
      '<div class="note-actions">' +
      '<button class="note-action-btn btn-edit" data-note-id="' + note.id + '"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>编辑</button>' +
      '<button class="note-action-btn btn-rename" data-note-id="' + note.id + '"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>重命名</button>' +
      '<button class="note-action-btn danger btn-delete" data-note-id="' + note.id + '"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>删除</button>' +
      '</div></div>' +
      '<div class="note-meta">📁 ' + escHtml(catName) + '  |  🕐 更新于 ' + formatFullDate(note.updatedAt) +
      (note.tags && note.tags.length ? '  |  🏷 ' + escHtml(note.tags.join(', ')) : '') +
      '</div><div class="md-content">' + renderMarkdown(note.content) + '</div></div>';

    mc.querySelector('.btn-edit').addEventListener('click', function () { openEditor(note); });
    mc.querySelector('.btn-rename').addEventListener('click', async function () {
      var nid = parseInt(this.dataset.noteId);
      var n = await storage.getNoteById(nid);
      if (!n) return;
      var name = prompt('输入新标题：', n.title);
      if (name && name.trim()) { await storage.updateNote(nid, { title: name.trim() }); renderNoteView(nid); }
    });
    mc.querySelector('.btn-delete').addEventListener('click', async function () {
      var nid = parseInt(this.dataset.noteId);
      if (confirm('确定删除这篇笔记？此操作不可恢复。')) {
        await storage.deleteNote(nid); renderSidebar(); navigateTo(null);
      }
    });

    // 搜索关键词定位
    if (keyword && keyword.trim().length > 0) {
      scrollToKeyword(mc.querySelector('.md-content'), keyword.trim());
    }
  }

  function scrollToKeyword(container, keyword) {
    // 高亮所有匹配文本节点
    var treeWalker = document.createTreeWalker(container, 4 /* NodeFilter.SHOW_TEXT */, null, false);
    var nodes = [], textNode;
    while (textNode = treeWalker.nextNode()) {
      if (textNode.textContent.toLowerCase().indexOf(keyword.toLowerCase()) !== -1) {
        nodes.push(textNode);
      }
    }
    // 从后往前替换，避免节点偏移
    for (var i = nodes.length - 1; i >= 0; i--) {
      var node = nodes[i];
      var parent = node.parentNode;
      if (parent.nodeType === 1 && (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE' || parent.tagName === 'MARK')) continue;
      var text = node.textContent;
      var lower = text.toLowerCase();
      var kw = keyword.toLowerCase();
      var idx = lower.indexOf(kw);
      if (idx === -1) continue;
      var frag = document.createDocumentFragment();
      frag.appendChild(document.createTextNode(text.slice(0, idx)));
      var mark = document.createElement('mark');
      mark.textContent = text.slice(idx, idx + kw.length);
      mark.className = 'search-highlight';
      frag.appendChild(mark);
      frag.appendChild(document.createTextNode(text.slice(idx + kw.length)));
      parent.replaceChild(frag, node);
    }
    // 滚动到第一个高亮位置
    var first = container.querySelector('.search-highlight');
    if (first) {
      first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  async function renderCategoryView(catId) {
    var cats = await storage.getAllCategories();
    var cat = cats.find(function (c) { return c.id === catId; });
    if (!cat) { document.getElementById('main-content').innerHTML = '<div class="empty-state"><div class="empty-state-text">分类不存在</div></div>'; return; }
    var notes = await storage.getNotesByCategory(catId);
    // 收集所有子分类（递归）
    var catByIdMap = {};
    for (var ci = 0; ci < cats.length; ci++) catByIdMap[cats[ci].id] = cats[ci];
    var subCats = [];
    function collectSubs(parentId) {
      for (var i = 0; i < cats.length; i++) {
        if (cats[i].parentId === parentId) {
          subCats.push(cats[i]);
          collectSubs(cats[i].id);
        }
      }
    }
    collectSubs(catId);
    var mc = document.getElementById('main-content');

    // 目录面包屑
    var crumbs = [];
    var cur = cat;
    while (cur) { crumbs.unshift(cur); cur = cur.parentId != null ? catByIdMap[cur.parentId] : null; }
    var breadcrumb = crumbs.map(function (c) { return escHtml(c.name); }).join(' / ');

    var html = '<div class="note-view"><h1 class="home-title">📁 ' + escHtml(cat.name) + '</h1>' +
      '<p class="home-subtitle">' + breadcrumb + ' ｜ 共 ' + notes.length + ' 篇笔记' + (subCats.length ? '，' + subCats.length + ' 个子目录' : '') + '</p>';

    // 子目录卡片
    if (subCats.length > 0) {
      html += '<div class="home-section"><h2 class="home-section-title">子目录</h2><div class="category-grid">';
      for (var s = 0; s < subCats.length; s++) {
        var sc = subCats[s];
        var scNotes = await storage.getNotesByCategory(sc.id);
        html += '<div class="category-card" data-home-cat="' + sc.id + '">' +
          '<div class="category-card-title">📂 ' + escHtml(sc.name) + '</div>' +
          '<div class="category-card-count">' + scNotes.length + ' 篇笔记</div></div>';
      }
      html += '</div></div>';
    }

    // 本目录下笔记
    if (notes.length > 0) {
      html += '<div class="home-section"><h2 class="home-section-title">笔记</h2><ul class="recent-notes-list">';
      for (var i = 0; i < notes.length; i++) {
        html += '<li class="recent-note-item" data-cat-note="' + notes[i].id + '">' +
          '<span class="recent-note-title">' + escHtml(notes[i].title) + '</span>' +
          '<span class="recent-note-date">' + formatFullDate(notes[i].updatedAt) + '</span></li>';
      }
      html += '</ul></div>';
    } else if (subCats.length === 0) {
      html += '<div class="empty-state"><div class="empty-state-icon">📝</div><div class="empty-state-text">该分类下暂无笔记</div></div>';
    }
    html += '</div>';
    mc.innerHTML = html;

    // 子目录卡片点击
    mc.querySelectorAll('.category-card').forEach(function (el) {
      el.addEventListener('click', function () { navigateTo(parseInt(el.dataset.homeCat)); });
    });
    // 笔记点击
    mc.querySelectorAll('.recent-note-item').forEach(function (el) {
      el.addEventListener('click', function () { openNote(parseInt(el.dataset.catNote)); });
    });
  }

  function renderAbout() {
    document.getElementById('main-content').innerHTML = '<div class="about-view">' +
      '<h1>⚡ 关于</h1>' +
      '<p><strong>Nov.</strong> — 一个面向嵌入式工程师的纯本地知识库网站。</p>' +
      '<p>使用纯前端技术构建（HTML + CSS + JavaScript），数据存储在浏览器本地存储中，无需任何后端服务。</p>' +
      '<p>适合管理芯片调试日志、底层驱动笔记、RTOS 学习资料、通信协议分析、项目踩坑记录等技术文档。</p>' +
      '<hr style="border:none;border-top:1px solid var(--border-color);margin:20px 0">' +
      '<h3>快捷键</h3>' +
      '<ul><li><code>Ctrl + F</code> — 聚焦搜索框</li>' +
      '<li><code>Ctrl + S</code> — 编辑器中保存笔记</li>' +
      '<li><code>Escape</code> — 关闭弹窗 / 搜索</li>' +
      '<li><code>Tab</code> — 编辑器中插入空格</li></ul>' +
      '<hr style="border:none;border-top:1px solid var(--border-color);margin:20px 0">' +
      '<p style="color:var(--text-muted);font-size:13px">版本 1.1.0 · 纯前端本地部署 · 无需联网</p></div>';
  }

  // ==================== 导航 ====================

  async function navigateTo(target, keyword) {
    closeSidebarMobile();
    if (target === null || target === 'home') {
      currentView = 'home'; activeCatId = null; activeNoteId = null;
      await renderSidebar(); await renderHome();
    } else if (target === 'new') {
      openEditor();
    } else if (target === 'about') {
      currentView = 'about'; activeCatId = null; activeNoteId = null;
      await renderSidebar(); renderAbout();
    } else if (typeof target === 'number') {
      var note = await storage.getNoteById(target);
      if (note) { openNote(target, keyword); }
      else { currentView = 'category'; activeCatId = target; activeNoteId = null; await renderSidebar(); renderCategoryView(target); }
    }
  }

  async function openNote(noteId, keyword) {
    activeNoteId = noteId;
    currentView = 'note';
    await renderSidebar();
    renderNoteView(noteId, keyword);
  }

  function closeSidebarMobile() {
    var sb = document.getElementById('sidebar');
    var bd = document.getElementById('sidebar-backdrop');
    if (sb) sb.classList.remove('open');
    if (bd) bd.classList.remove('active');
  }

  // ==================== 编辑器 ====================

  // 构建带缩进层级的分类下拉选项（全角空格缩进，select 中可见）
  function buildCategoryOptions(cats, selectedId) {
    var byParentMap = {};
    var roots = [];
    for (var i = 0; i < cats.length; i++) {
      var pid = (cats[i].parentId === undefined) ? null : cats[i].parentId;
      if (pid === null) roots.push(cats[i]);
      else {
        if (!byParentMap[pid]) byParentMap[pid] = [];
        byParentMap[pid].push(cats[i]);
      }
    }
    var sorter = function (a, b) { return (a.order || 0) - (b.order || 0); };
    roots.sort(sorter);
    for (var key in byParentMap) byParentMap[key].sort(sorter);

    var html = '';
    function walk(cat, depth) {
      var prefix = '';
      for (var d = 0; d < depth; d++) prefix += '　　';
      if (depth > 0) prefix += '└ ';
      html += '<option value="' + cat.id + '"' + (cat.id === selectedId ? ' selected' : '') + '>' + prefix + escHtml(cat.name) + '</option>';
      var children = byParentMap[cat.id] || [];
      for (var i = 0; i < children.length; i++) walk(children[i], depth + 1);
    }
    for (var r = 0; r < roots.length; r++) walk(roots[r], 0);
    return html;
  }

  // ==================== 原地编辑模式 ====================

  // 进入编辑模式：右侧原地切换为编辑器
  function enterEditMode(note) {
    var mc = document.getElementById('main-content');
    if (!mc) return;
    editingNote = note;
    editorMode = true;
    mc.classList.add('edit-mode');
    var badge = document.getElementById('mode-badge');
    if (badge) badge.classList.add('visible');

    buildInlineEditor(note).then(function () {
      var titleIn = document.getElementById('edit-title-input');
      if (titleIn) titleIn.focus();
    });
  }

  // 退出编辑模式：切回阅读视图
  function exitEditMode(refreshNoteId) {
    var mc = document.getElementById('main-content');
    if (!mc) return;
    editorMode = false;
    editingNote = null;
    mc.classList.remove('edit-mode');
    var badge = document.getElementById('mode-badge');
    if (badge) badge.classList.remove('visible');

    // 移除编辑器内联事件
    if (cleanupInlineEditor) { cleanupInlineEditor(); cleanupInlineEditor = null; }

    if (refreshNoteId) {
      openNote(refreshNoteId);
    } else {
      // 取消后回到之前状态
      if (activeNoteId) {
        openNote(activeNoteId);
      } else {
        renderHome();
      }
    }
  }

  async function buildInlineEditor(note) {
    var mc = document.getElementById('main-content');
    var cats = await storage.getAllCategories();
    var targetCatId = note ? note.categoryId : (cats.length > 0 ? cats[0].id : null);

    var html = '<div class="editor-inline">' +
      '<div class="edit-header">' +
      '<input type="text" class="edit-title-input" id="edit-title-input" placeholder="笔记标题" value="' + (note && note.title ? escHtml(note.title) : '') + '">' +
      '<select class="edit-category-select" id="edit-category-select">' + buildCategoryOptions(cats, targetCatId) + '</select>' +
      '<div class="edit-actions">' +
      '<button class="edit-btn" id="edit-cancel-btn">取消</button>' +
      '<button class="edit-btn primary" id="edit-save-btn">保存</button>' +
      '</div></div>' +
      '<textarea class="edit-textarea" id="edit-content-textarea" placeholder="在此编写 Markdown 笔记...">' + (note && note.content ? escHtml(note.content) : '') + '</textarea>' +
      '</div>';

    mc.innerHTML = html;

    var titleIn = document.getElementById('edit-title-input');
    var catSel = document.getElementById('edit-category-select');
    var contentIn = document.getElementById('edit-content-textarea');
    var saveBtn = document.getElementById('edit-save-btn');
    var cancelBtn = document.getElementById('edit-cancel-btn');

    var doSave = async function () {
      var title = titleIn.value.trim() || '无标题';
      var content = contentIn.value;
      var catId = parseInt(catSel.value);
      var nid;
      if (note && note.id) {
        await storage.updateNote(note.id, { title: title, content: content, categoryId: catId });
        nid = note.id;
      } else {
        nid = await storage.addNote({ title: title, content: content, categoryId: catId });
      }
      var all = await storage.getAllNotes(); rebuildSearchIndex(all);
      exitEditMode(nid);
      renderSidebar();
    };

    var doCancel = function () { exitEditMode(null); };

    var keyHandler = function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); doSave(); }
      if (e.key === 'Escape') doCancel();
    };

    contentIn.addEventListener('keydown', tabHandler);

    saveBtn.addEventListener('click', doSave);
    cancelBtn.addEventListener('click', doCancel);
    document.addEventListener('keydown', keyHandler);

    cleanupInlineEditor = function () {
      saveBtn.removeEventListener('click', doSave);
      cancelBtn.removeEventListener('click', doCancel);
      document.removeEventListener('keydown', keyHandler);
      contentIn.removeEventListener('keydown', tabHandler);
    };
  }

  async function openEditor(note, defaultCatId) {
    // 原地编辑模式
    // 如果是新建（note 为 null）但有 defaultCatId，构造一个虚拟 note
    if (!note && defaultCatId) {
      note = { categoryId: defaultCatId };
    }
    enterEditMode(note);
  }

  function closeEditor() {
    exitEditMode(null);
  }

  function tabHandler(e) {
    if (e.key === 'Tab') { e.preventDefault(); var ta = e.target, s = ta.selectionStart; ta.value = ta.value.substring(0, s) + '  ' + ta.value.substring(ta.selectionEnd); ta.selectionStart = ta.selectionEnd = s + 2; }
  }

  // ==================== 搜索下拉 ====================

  function renderSearchResults(results, keyword) {
    var container = document.getElementById('search-results');
    if (!results.length) { container.innerHTML = '<div class="search-result-item" style="color:var(--text-muted)">无匹配结果</div>'; container.classList.add('active'); return; }
    container.innerHTML = results.slice(0, 10).map(function (r) {
      return '<div class="search-result-item" data-sid="' + r.id + '"><div class="search-result-title">' + escHtml(r.title) + '</div><div class="search-result-excerpt">' + r.excerpt + '</div></div>';
    }).join('');
    container.classList.add('active');
    container._searchKeyword = keyword || '';
    container._searchClick = function (e) {
      var item = e.target.closest('.search-result-item');
      if (!item) return;
      container.classList.remove('active');
      document.getElementById('search-input').value = '';
      navigateTo(parseInt(item.dataset.sid), container._searchKeyword);
      container.removeEventListener('click', container._searchClick);
    };
    container.addEventListener('click', container._searchClick);
  }

  // 分类选择弹窗（导入用，带搜索）
  function showCategoryPicker(onSelect) {
    var overlay = document.getElementById('cat-picker-overlay');
    var sel = document.getElementById('cat-picker-select');
    var searchInput = document.getElementById('cat-picker-search');
    var allCats = [];
    var filterFn = function () {
      var q = searchInput.value.toLowerCase().trim();
      sel.innerHTML = '';
      for (var i = 0; i < allCats.length; i++) {
        if (q && allCats[i].name.toLowerCase().indexOf(q) === -1) continue;
        var opt = document.createElement('option');
        opt.value = allCats[i].id;
        opt.textContent = allCats[i].name;
        sel.appendChild(opt);
      }
      if (sel.options.length > 0) sel.selectedIndex = 0;
    };

    storage.getAllCategories().then(function (cats) {
      allCats = cats;
      searchInput.value = '';
      filterFn();
      overlay.classList.add('active');
      setTimeout(function () { searchInput.focus(); }, 50);
    });

    var ok = document.getElementById('cat-picker-confirm');
    var cancel = document.getElementById('cat-picker-cancel');
    var handler = function () {
      overlay.classList.remove('active');
      if (sel.options.length > 0 && sel.value) onSelect(sel.value);
      cleanup();
    };
    var cleanup = function () {
      overlay.classList.remove('active');
      ok.removeEventListener('click', handler);
      cancel.removeEventListener('click', cleaner);
      sel.removeEventListener('keydown', kh);
      searchInput.removeEventListener('input', filterFn);
      searchInput.removeEventListener('keydown', searchKh);
    };
    var cleaner = function () { cleanup(); };
    var kh = function (e) { if (e.key === 'Enter') handler(); if (e.key === 'Escape') cleanup(); };
    var searchKh = function (e) { if (e.key === 'Enter') { e.preventDefault(); handler(); } if (e.key === 'Escape') cleanup(); };
    ok.addEventListener('click', handler);
    cancel.addEventListener('click', cleaner);
    sel.addEventListener('keydown', kh);
    searchInput.addEventListener('input', filterFn);
    searchInput.addEventListener('keydown', searchKh);
  }

  // ==================== 模态框 ====================

  function showModal(title, value, onConfirm) {
    var modal = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = title;
    var input = document.getElementById('modal-input');
    input.value = value || '';
    modal.classList.add('active');
    input.focus(); input.select();

    var confirmBtn = document.getElementById('modal-confirm');
    var cancelBtn = document.getElementById('modal-cancel');

    var handler = function () { var v = input.value.trim(); if (v) onConfirm(v); cleanup(); };
    var cleanup = function () { modal.classList.remove('active'); confirmBtn.removeEventListener('click', handler); cancelBtn.removeEventListener('click', cleanup); input.removeEventListener('keydown', kh); };
    var kh = function (e) { if (e.key === 'Enter') handler(); if (e.key === 'Escape') cleanup(); };
    confirmBtn.addEventListener('click', handler);
    cancelBtn.addEventListener('click', cleanup);
    input.addEventListener('keydown', kh);
  }

  // ==================== 示例数据 ====================

  async function seedExampleData() {
    var c1 = await storage.addCategory('STM32 驱动开发');
    var c2 = await storage.addCategory('RTOS 学习笔记');
    var c3 = await storage.addCategory('蓝牙与音频');
    var c4 = await storage.addCategory('工具链踩坑');
    var c5 = await storage.addCategory('硬件调试日志');

    await storage.addNote({ title: 'STM32 GPIO 初始化与 HAL 库使用', categoryId: c1, tags: ['STM32', 'GPIO', 'HAL'],
      content: '# STM32 GPIO 初始化与 HAL 库使用\n\n## 概述\n\nGPIO 是嵌入式开发最基础的外设。STM32 使用 HAL 库可以大幅简化 GPIO 初始化流程。\n\n## HAL 库初始化方式\n\n```c\n/* GPIO 初始化示例：配置 PA5 为推挽输出（板载 LED） */\nvoid LED_GPIO_Init(void)\n{\n    GPIO_InitTypeDef GPIO_InitStruct = {0};\n\n    /* 使能 GPIOA 时钟 */\n    __HAL_RCC_GPIOA_CLK_ENABLE();\n\n    /* 配置 PA5 */\n    GPIO_InitStruct.Pin   = GPIO_PIN_5;\n    GPIO_InitStruct.Mode  = GPIO_MODE_OUTPUT_PP;    /* 推挽输出 */\n    GPIO_InitStruct.Pull  = GPIO_NOPULL;\n    GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;\n    HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);\n\n    /* 默认熄灭 LED */\n    HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5, GPIO_PIN_SET);\n}\n```\n\n## 寄存器直接操作方式\n\n```c\n/* 直接操作寄存器配置 PA5 为输出 */\nvoid LED_GPIO_Init_Reg(void)\n{\n    /* 使能 GPIOA 时钟 (AHB1ENR bit0) */\n    RCC->AHB1ENR |= RCC_AHB1ENR_GPIOAEN;\n\n    /* 配置 MODER: PA5 → 01 (输出模式) */\n    GPIOA->MODER &= ~GPIO_MODER_MODE5;\n    GPIOA->MODER |= (0x01 << (5 * 2));\n\n    /* 默认高电平熄灭 */\n    GPIOA->BSRR = GPIO_BSRR_BS5;\n}\n```\n\n## 注意事项\n\n1. **时钟必须先使能**：忘记使能时钟是最常见的 Bug 来源\n2. **复用功能**：SPI/UART/I2C 引脚需要配置为 `GPIO_MODE_AF_PP`\n3. **速度选择**：低速(2MHz)足够 LED，高速(50MHz+)才用于 SPI/SDIO' });

    await storage.addNote({ title: 'FreeRTOS 任务创建与调度机制', categoryId: c2, tags: ['FreeRTOS', '任务', '调度'],
      content: '# FreeRTOS 任务创建与调度机制\n\n## 任务创建\n\n```c\n#include "FreeRTOS.h"\n#include "task.h"\n\nvoid vTaskLED(void *pvParameters);\n\nvoid CreateTasks(void)\n{\n    BaseType_t ret = xTaskCreate(\n        vTaskLED,          /* 任务函数 */\n        "LED_Task",        /* 任务名称 */\n        128,               /* 栈大小（字） */\n        NULL,              /* 任务参数 */\n        1,                 /* 优先级 */\n        NULL               /* 任务句柄 */\n    );\n    if (ret != pdPASS) Error_Handler();\n}\n\nvoid vTaskLED(void *pvParameters)\n{\n    for (;;) {\n        HAL_GPIO_TogglePin(GPIOA, GPIO_PIN_5);\n        vTaskDelay(pdMS_TO_TICKS(500));\n    }\n}\n```\n\n## 常用 API\n\n| API | 作用 |\n|-----|------|\n| `xTaskCreate()` | 创建动态任务 |\n| `vTaskDelay()` | 阻塞延时 |\n| `vTaskSuspend()` | 挂起任务 |\n| `vTaskResume()` | 恢复任务 |\n\n## 踩坑记录\n\n> **问题**：任务创建后不执行\n> **原因**：`configTOTAL_HEAP_SIZE` 设置过小\n> **解决**：从 2KB 增大到 10KB\n\n```log\n[INFO] FreeRTOS starting scheduler...\n[DEBUG] Heap size: 10240 bytes\n[WARN] xTaskCreate returned error: memory allocation failed\n[ERROR] Scheduler failed to start - insufficient heap\n```\n\n## ARM Cortex-M PendSV 上下文切换\n\n```asm\n; PendSV Handler 简化版\nPendSV_Handler:\n    cpsid i                     ; 关闭中断\n    mrs r0, psp                 ; 读取进程栈指针\n    stmdb r0!, {r4-r11}         ; 保存 R4-R11\n    str lr, [r0, #32]           ; 保存 EXC_RETURN\n    bl vTaskSwitchContext       ; 选择下一个任务\n    ldr lr, [r0, #32]           ; 恢复 EXC_RETURN\n    ldmia r0!, {r4-r11}         ; 恢复 R4-R11\n    msr psp, r0                 ; 更新进程栈指针\n    cpsie i                     ; 开启中断\n    bx lr                       ; 返回\n```' });

    await storage.addNote({ title: '蓝牙 A2DP Sink 音频输出调试记录', categoryId: c3, tags: ['蓝牙', 'A2DP', 'ESP32', 'I2S'],
      content: '# 蓝牙 A2DP Sink 音频输出调试记录\n\n## 环境\n\n- 芯片：ESP32-S3\n- 协议：Bluetooth Classic (A2DP Sink)\n- 音频输出：I2S → PCM5102 DAC\n\n## 问题描述\n\n蓝牙配对成功，手机可以连接，但播放音乐时**无声音输出**。\n\n## 排查过程\n\n### Step 1: 确认 I2S 配置\n\n```c\ni2s_config_t i2s_cfg = {\n    .mode               = I2S_MODE_MASTER | I2S_MODE_TX,\n    .sample_rate         = 44100,\n    .bits_per_sample     = I2S_BITS_PER_SAMPLE_16BIT,\n    .channel_format      = I2S_CHANNEL_FMT_RIGHT_LEFT,\n    .communication_format = I2S_COMM_FORMAT_STAND_I2S,\n    .dma_buf_count       = 6,\n    .dma_buf_len         = 256,\n};\n```\n\n### Step 2: 日志分析\n\n```log\n[I][APP] Bluetooth A2DP Sink demo starting...\n[I][APP] Device found: XX:XX:XX:XX:XX:XX (iPhone)\n[I][APP] Pairing successful\n[I][APP] A2DP connection established\n[D][I2S] DMA buffer initialized: 6 buffers x 256 samples\n[W][I2S] APLL acquire failed, fallback to PLL_D2\n[E][I2S] I2S write failed: ESP_ERR_TIMEOUT\n[E][I2S] I2S write failed: ESP_ERR_TIMEOUT\n```\n\n### 根因\n\nI2S DMA 写入超时 → PCM5102 的 **BCK/LRCK 引脚接线错误**\n\n### 解决\n\n交换 BCK 和 LRCK 接线后正常输出。' });

    await storage.addNote({ title: 'OpenOCD 烧录失败：CMSIS-DAP 识别问题', categoryId: c4, tags: ['OpenOCD', 'CMSIS-DAP', '烧录'],
      content: '# OpenOCD 烧录失败：CMSIS-DAP 识别问题\n\n## 问题\n\n```log\n[INFO] OpenOCD 0.12.0 starting...\n[INFO] CMSIS-DAP: SWD Mode\n[ERROR] Error: CMSIS-DAP command CMD_DAP_SWJ_CLOCK failed\n[ERROR] Error: Could not initialize the debug port\n```\n\n## 排查\n\n1. 检查 DAPLink 固件版本 → `0254`（较旧）\n2. 检查接线：SWDIO / SWCLK / GND / 3V3 → 接线正确\n3. 尝试降低 SWD 时钟频率 → **有效！**\n\n## 解决\n\n```\n# openocd.cfg\nadapter driver cmsis-dap\nadapter speed 1000       # 降低 SWD 时钟到 1MHz\ntransport select swd\nset CHIPNAME STM32F103C8\nsource [find target/stm32f1x.cfg]\n```\n\n## 教训\n\n- 长杜邦线 + 高 SWD 时钟 → 信号完整性问题\n- 生产环境建议 `adapter speed 4000` 以下' });

    await storage.addNote({ title: 'STM32 SPI Flash (W25Q64) 读写调试', categoryId: c5, tags: ['SPI', 'Flash', 'W25Q64'],
      content: '# STM32 SPI Flash (W25Q64) 读写调试\n\n## 硬件连接\n\n| 引脚 | STM32 | W25Q64 |\n|------|-------|--------|\n| SCK  | PA5   | CLK    |\n| MOSI | PA7   | DI     |\n| MISO | PA6   | DO     |\n| CS   | PA4   | CS     |\n\n## 初始化代码\n\n```c\nvoid SPI1_Init(void)\n{\n    __HAL_RCC_SPI1_CLK_ENABLE();\n    __HAL_RCC_GPIOA_CLK_ENABLE();\n\n    GPIO_InitTypeDef gpio = {0};\n    gpio.Pin   = GPIO_PIN_5 | GPIO_PIN_6 | GPIO_PIN_7;\n    gpio.Mode  = GPIO_MODE_AF_PP;\n    gpio.Pull  = GPIO_NOPULL;\n    gpio.Speed = GPIO_SPEED_FREQ_HIGH;\n    gpio.Alternate = GPIO_AF5_SPI1;\n    HAL_GPIO_Init(GPIOA, &gpio);\n\n    hspi1.Instance               = SPI1;\n    hspi1.Init.Mode              = SPI_MODE_MASTER;\n    hspi1.Init.CLKPolarity       = SPI_POLARITY_LOW;\n    hspi1.Init.CLKPhase          = SPI_PHASE_1EDGE;\n    hspi1.Init.BaudRatePrescaler = SPI_BAUDRATEPRESCALER_4;\n    HAL_SPI_Init(&hspi1);\n}\n```\n\n## 读取 JEDEC ID\n\n```c\nuint32_t W25Q_ReadJEDECID(void)\n{\n    uint8_t cmd = 0x9F;\n    uint8_t rx[3] = {0};\n    W25Q_CS_LOW();\n    HAL_SPI_Transmit(&hspi1, &cmd, 1, 10);\n    HAL_SPI_Receive(&hspi1, rx, 3, 10);\n    W2Q_CS_HIGH();\n    return (rx[0] << 16) | (rx[1] << 8) | rx[2];\n}\n```\n\n## 调试日志\n\n```log\n[INFO] SPI1 initialized, baudrate: 18000000\n[DEBUG] TX: 9F\n[DEBUG] RX: EF 40 17\n[INFO] JEDEC ID: 0xEF4017 ✓ (Winbond W25Q64JV)\n[PASS] W25Q64 initialization complete\n```\n\n## 常见问题\n\n1. **读到全 0xFF** → 检查接线和 SPI 模式\n2. **读到全 0x00** → MISO 线可能断路\n3. **ID 不对** → 芯片型号不匹配' });
  }

  // ==================== 初始化 ====================

  async function init() {
    try {
      // 初始化主题
      initTheme();

      // 初始化深空特效（星空、光标、粒子）
      detectMobile();
      initStarfield();
      initCursor();
      initParticles();
      initPet();

      // 初始化存储（自动选择 IndexedDB 或 localStorage）
      await initStorage();

      // 检查是否需要导入示例数据
      var cats = await storage.getAllCategories();
      if (cats.length === 0) await seedExampleData();

      // 重建搜索索引
      var allNotes = await storage.getAllNotes();
      rebuildSearchIndex(allNotes);

      // 显示应用
      document.getElementById('loading-screen').style.display = 'none';
      document.getElementById('app-header').style.display = 'flex';
      document.getElementById('app-body').style.display = 'flex';

      // 渲染侧边栏
      await renderSidebar();

      // === 侧边栏事件委托 ===
      var sidebarContent = document.getElementById('sidebar-content');
      sidebarContent.addEventListener('click', function (e) {
        var target = e.target;

        var renameBtn = target.closest('.btn-rename-cat');
        if (renameBtn) {
          var rid = parseInt(renameBtn.dataset.catId);
          var rc = catsArr.find(function (c) { return c.id === rid; });
          if (rc) showModal('重命名分类', rc.name, function (v) { storage.updateCategory(rid, v).then(function () { renderSidebar(); navigateTo(rid); }); });
          return;
        }
        var delBtn = target.closest('.btn-delete-cat');
        if (delBtn) {
          var did = parseInt(delBtn.dataset.catId);
          if (confirm('确定删除该分类及其所有笔记？此操作不可恢复。')) {
            storage.deleteCategory(did).then(function () { if (activeCatId === did) activeCatId = null; renderSidebar(); navigateTo(null); });
          }
          return;
        }
        // 侧边栏直接删除笔记
        var delNoteBtn = target.closest('.btn-delete-note-inline');
        if (delNoteBtn) {
          var nid = parseInt(delNoteBtn.dataset.noteId);
          if (confirm('确定删除这篇笔记？此操作不可恢复。')) {
            storage.deleteNote(nid).then(function () {
              if (activeNoteId === nid) { activeNoteId = null; }
              renderSidebar();
              navigateTo(null);
            });
          }
          e.stopPropagation();
          return;
        }
        var subcatBtn = target.closest('.btn-add-subcat');
        if (subcatBtn) {
          var pid = parseInt(subcatBtn.dataset.catId);
          showModal('新增子目录', '', function (v) {
            storage.addChildCategory(v, pid).then(function () {
              expandedCats.add(pid);
              renderSidebar();
              navigateTo(pid);
            });
          });
          return;
        }
        var addItem = target.closest('.note-item-add');
        if (addItem) {
          openEditor(null, parseInt(addItem.dataset.catAdd));
          return;
        }
        // 点击笔记（排除拖拽手柄）
        var noteItem = target.closest('.note-item[data-note-id]');
        if (noteItem) {
          activeNoteId = parseInt(noteItem.dataset.noteId);
          renderSidebar();
          openNote(activeNoteId);
          return;
        }
        // 分类头部：展开/折叠 + 导航（排除 actions 区域和拖拽手柄）
        var catHeader = target.closest('.category-header');
        if (catHeader && !target.closest('.category-actions') && !target.closest('.drag-handle')) {
          var catId = parseInt(catHeader.dataset.catId);
          if (expandedCats.has(catId)) expandedCats.delete(catId); else expandedCats.add(catId);
          activeCatId = catId;
          renderSidebar();
          navigateTo(catId);
          return;
        }
      });

      // === 侧边栏拖拽排序 / 移动 ===
      var dragSrcEl = null;
      var dragType = null; // 'cat' or 'note'

      sidebarContent.addEventListener('dragstart', function (e) {
        var target = e.target;
        var noteItem = target.closest('.note-item[data-note-id]');
        // 必须先检查笔记，因为 .note-item 在 .category-item 内部
        if (noteItem) {
          dragType = 'note';
          dragSrcEl = noteItem;
          e.dataTransfer.setData('text/note-id', noteItem.dataset.noteId);
          e.dataTransfer.effectAllowed = 'move';
          noteItem.classList.add('dragging');
          return;
        }
        var catItem = target.closest('.category-item');
        if (catItem) {
          dragType = 'cat';
          dragSrcEl = catItem;
          e.dataTransfer.setData('text/cat-id', catItem.dataset.catId);
          e.dataTransfer.effectAllowed = 'move';
          catItem.classList.add('dragging');
          return;
        }
        e.preventDefault();
      });

      sidebarContent.addEventListener('dragend', function () {
        if (dragSrcEl) dragSrcEl.classList.remove('dragging');
        clearDragOver();
        dragSrcEl = null;
        dragType = null;
      });

      function clearDragOver() {
        sidebarContent.querySelectorAll('.drag-over').forEach(function (el) {
          el.classList.remove('drag-over');
        });
      }

      sidebarContent.addEventListener('dragover', function (e) {
        e.preventDefault();
        var target = e.target;
        clearDragOver();
        if (dragType === 'cat') {
          var catItem = target.closest('.category-item');
          if (catItem) {
            catItem.classList.add('drag-over');
            e.dataTransfer.dropEffect = 'move';
          } else {
            e.dataTransfer.dropEffect = 'none';
          }
        } else if (dragType === 'note') {
          var noteItem = target.closest('.note-item[data-note-id]');
          var catItem2 = target.closest('.category-item');
          if (noteItem) {
            noteItem.classList.add('drag-over');
            e.dataTransfer.dropEffect = 'move';
          } else if (catItem2) {
            catItem2.classList.add('drag-over');
            e.dataTransfer.dropEffect = 'move';
          } else {
            e.dataTransfer.dropEffect = 'none';
          }
        }
      });

      sidebarContent.addEventListener('drop', function (e) {
        e.preventDefault();
        clearDragOver();
        var target = e.target;

        if (!dragSrcEl) return;

        if (dragType === 'cat') {
          var srcCatId = parseInt(dragSrcEl.dataset.catId);
          var targetCatItem = target.closest('.category-item');
          if (!targetCatItem) return;
          var targetCatId = parseInt(targetCatItem.dataset.catId);
          if (srcCatId && targetCatId && srcCatId !== targetCatId) {
            storage.reorderCategories(srcCatId, targetCatId).then(function () {
              renderSidebar();
            });
          }
        } else if (dragType === 'note') {
          var srcNoteId = parseInt(dragSrcEl.dataset.noteId);
          var targetNoteItem = target.closest('.note-item[data-note-id]');
          var targetCatItem2 = target.closest('.category-item');

          if (targetNoteItem) {
            var targetNoteId = parseInt(targetNoteItem.dataset.noteId);
            if (srcNoteId && targetNoteId && srcNoteId !== targetNoteId) {
              swapOrMoveNotes(srcNoteId, targetNoteId).then(function () {
                renderSidebar();
              });
            }
          } else if (targetCatItem2) {
            var targetCatId2 = parseInt(targetCatItem2.dataset.catId);
            if (srcNoteId && targetCatId2) {
              storage.updateNote(srcNoteId, { categoryId: targetCatId2 }).then(function () {
                renderSidebar();
              });
            }
          }
        }
      });

      // ==================== 辅助函数 ====================

      /**
       * 把 srcNote 拖到 targetNote 的位置：
       *  - 同分类：交换 sortOrder
       *  - 跨分类：把 srcNote 的 categoryId 改为 targetNote 的分类，插到 targetNote 前面
       */
      async function swapOrMoveNotes(srcNoteId, targetNoteId) {
        var srcNote = await storage.getNoteById(srcNoteId);
        var targetNote = await storage.getNoteById(targetNoteId);
        if (!srcNote || !targetNote) return;

        if (srcNote.categoryId === targetNote.categoryId) {
          // 同分类：交换 sortOrder
          var tmp = srcNote.sortOrder != null ? srcNote.sortOrder : srcNoteId;
          srcNote.sortOrder = targetNote.sortOrder != null ? targetNote.sortOrder : targetNoteId;
          targetNote.sortOrder = tmp;
          await storage.updateNote(srcNoteId, { sortOrder: srcNote.sortOrder });
          await storage.updateNote(targetNoteId, { sortOrder: targetNote.sortOrder });
        } else {
          // 跨分类：移动到目标分类，取目标笔记的 sortOrder 之左（减 1 插前边）
          var targetSort = targetNote.sortOrder != null ? targetNote.sortOrder : targetNoteId;
          await storage.updateNote(srcNoteId, {
            categoryId: targetNote.categoryId,
            sortOrder: targetSort - 0.5
          });
        }
      }

      // === 侧边栏宽度调节 ===
      var resizeHandle = document.getElementById('sidebar-resize-handle');
      var sidebarEl = document.getElementById('sidebar');
      var RESIZE_MIN = 180, RESIZE_MAX = 600;
      var savedW = localStorage.getItem('sidebar-width');
      if (savedW) sidebarEl.style.width = savedW + 'px';

      resizeHandle.addEventListener('mousedown', function (e) {
        e.preventDefault();
        resizeHandle.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        function onMove(ev) {
          var w = Math.max(RESIZE_MIN, Math.min(RESIZE_MAX, ev.clientX));
          sidebarEl.style.width = w + 'px';
        }
        function onUp() {
          resizeHandle.classList.remove('active');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          localStorage.setItem('sidebar-width', parseInt(sidebarEl.style.width));
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      // === 顶部导航事件 ===
      document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

      document.getElementById('sidebar-toggle').addEventListener('click', function () {
        document.getElementById('sidebar').classList.toggle('open');
        document.getElementById('sidebar-backdrop').classList.toggle('active');
      });

      document.getElementById('sidebar-backdrop').addEventListener('click', function () {
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('sidebar-backdrop').classList.remove('active');
      });

      // 搜索
      var searchInput = document.getElementById('search-input');
      var searchResults = document.getElementById('search-results');
      var searchTimer = null;
      searchInput.addEventListener('input', function () {
        clearTimeout(searchTimer);
        var q = searchInput.value.trim();
        searchTimer = setTimeout(function () {
          if (q.length < 1) { searchResults.classList.remove('active'); searchResults.innerHTML = ''; return; }
          renderSearchResults(searchNotes(q), q);
        }, 150);
      });

      document.addEventListener('click', function (e) {
        if (!e.target.closest('.search-wrapper')) searchResults.classList.remove('active');
      });

      document.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'k')) { e.preventDefault(); searchInput.focus(); searchInput.select(); }
        if (e.key === 'Escape') { searchResults.classList.remove('active'); searchInput.blur(); }
      });

      // 导出全部数据（JSON 备份）
      document.getElementById('btn-export').addEventListener('click', async function () {
        try {
          var cats = await storage.getAllCategories();
          var notes = await storage.getAllNotes();
          var data = {
            version: 1,
            exportDate: new Date().toISOString(),
            categories: cats,
            notes: notes
          };
          var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = 'nov-backup-' + new Date().toISOString().slice(0, 10) + '.json';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } catch (err) {
          alert('导出失败：' + err.message);
        }
      });

      // 侧边栏：导入 MD 文件
      document.getElementById('btn-import-md').addEventListener('click', function () {
        showCategoryPicker(function (catId) {
          var btn = document.getElementById('btn-import-md');
          btn.dataset.targetCatId = catId;
          document.getElementById('md-file-input').click();
        });
      });

      // 顶部：导入 JSON 备份
      document.getElementById('btn-import').addEventListener('click', function () { document.getElementById('json-file-input').click(); });

      // MD 文件导入
      document.getElementById('md-file-input').addEventListener('change', async function (e) {
        var files = Array.from(e.target.files);
        if (!files.length) return;
        var btn = document.getElementById('btn-import-md');
        var catId = btn.dataset.targetCatId;
        if (!catId) { alert('请先点击侧边栏的导入按钮选择分类。'); return; }
        var cats = await storage.getAllCategories();
        var target = cats.find(function (c) { return c.id === parseInt(catId); });
        if (!target) { alert('目标分类不存在。'); document.getElementById('md-file-input').value = ''; return; }
        var count = 0;
        for (var i = 0; i < files.length; i++) {
          var txt = await files[i].text();
          var h1 = txt.match(/^#\s+(.+)$/m);
          var title = h1 ? h1[1].trim() : files[i].name.replace(/\.(md|markdown|txt)$/i, '');
          await storage.addNote({ title: title, content: txt, categoryId: parseInt(catId), tags: [] });
          count++;
        }
        var all = await storage.getAllNotes(); rebuildSearchIndex(all);
        document.getElementById('md-file-input').value = '';
        delete btn.dataset.targetCatId;
        await renderSidebar(); navigateTo(null);
        alert('成功导入 ' + count + ' 篇笔记到「' + target.name + '」分类。');
      });

      // JSON 备份导入（恢复）
      document.getElementById('json-file-input').addEventListener('change', async function (e) {
        var file = e.target.files[0];
        if (!file) return;
        try {
          var txt = await file.text();
          var data = JSON.parse(txt);
          if (!data.categories || !data.notes) {
            alert('无效的备份文件格式。');
            document.getElementById('json-file-input').value = '';
            return;
          }
          var mode = confirm('确定 → 合并导入（保留现有数据）\n取消 → 完全替换（清空现有数据后恢复）');
          if (mode) {
            // 合并模式：先恢复分类，再恢复笔记
            for (var i = 0; i < data.categories.length; i++) {
              var c = data.categories[i];
              try {
                await storage.addCategory(c.name, c.order, c.parentId);
              } catch (_) {
                // 分类名已存在，跳过
              }
            }
            var allCats = await storage.getAllCategories();
            var nameToId = {};
            for (var j = 0; j < allCats.length; j++) nameToId[allCats[j].name] = allCats[j].id;
            var count = 0;
            for (var k = 0; k < data.notes.length; k++) {
              var n = data.notes[k];
              var newCatId = nameToId[n.name] || (allCats.length > 0 ? allCats[0].id : null);
              await storage.addNote({ title: n.title, content: n.content, categoryId: newCatId, tags: n.tags || [] });
              count++;
            }
            alert('合并完成：新增 ' + count + ' 篇笔记。');
          } else {
            // 替换模式：清空现有数据，再恢复
            var existingCats = await storage.getAllCategories();
            for (var i = 0; i < existingCats.length; i++) {
              await storage.deleteCategory(existingCats[i].id);
            }
            // 重新创建分类（保持原始 ID 和顺序）
            var idMap = {};
            for (var j = 0; j < data.categories.length; j++) {
              var c = data.categories[j];
              var newId = await storage.addCategory(c.name, c.order, c.parentId);
              idMap[c.id] = newId;
            }
            // 恢复笔记（用新分类 ID 映射）
            var newCats = await storage.getAllCategories();
            var oldIdToNewCatId = {};
            for (var k = 0; k < newCats.length; k++) {
              var nc = newCats[k];
              var oldCat = data.categories.find(function (dc) { return dc.name === nc.name; });
              if (oldCat) oldIdToNewCatId[oldCat.id] = nc.id;
            }
            var count = 0;
            for (var n = 0; n < data.notes.length; n++) {
              var note = data.notes[n];
              var catId = oldIdToNewCatId[note.categoryId] || (newCats.length > 0 ? newCats[0].id : null);
              await storage.addNote({ title: note.title, content: note.content, categoryId: catId, tags: note.tags || [] });
              count++;
            }
            alert('替换完成：恢复 ' + count + ' 篇笔记。');
          }
          var all = await storage.getAllNotes(); rebuildSearchIndex(all);
          await renderSidebar(); navigateTo(null);
        } catch (err) {
          alert('导入失败：' + err.message);
        }
        document.getElementById('json-file-input').value = '';
      });

      // 首页
      document.getElementById('btn-home').addEventListener('click', function () { navigateTo('home'); });

      // 关于
      document.getElementById('btn-about').addEventListener('click', function () { navigateTo('about'); });

      // 新增分类
      document.getElementById('btn-add-category').addEventListener('click', function () {
        storage.getAllCategories().then(function (cats) {
          catsArr = cats;
          showModal('新增分类', '', function (v) { storage.addCategory(v, cats.length).then(function () { renderSidebar(); navigateTo(null); }); });
        });
      });

      // 新建笔记
      document.getElementById('btn-add-note').addEventListener('click', function () { openEditor(); });

      // 编辑器取消
      document.getElementById('editor-cancel').addEventListener('click', closeEditor);

      // 模态框取消
      document.getElementById('modal-cancel').addEventListener('click', function () {
        document.getElementById('modal-overlay').classList.remove('active');
      });

      // 默认首页
      await renderHome();
    } catch (err) {
      console.error('App init failed:', err);
      document.getElementById('loading-screen').innerHTML =
        '<div style="text-align:center;color:#ef4444;padding:40px;font-family:sans-serif">' +
        '<h2>初始化失败</h2><p style="margin:8px 0;color:#8b949e">' + escHtml(err.message) + '</p>' +
        '<p style="color:#8b949e;font-size:12px;margin-top:12px;line-height:1.6">' +
        '请尝试以下操作：<br>' +
        '1. 使用 Chrome / Edge / Firefox 最新版打开<br>' +
        '2. 关闭所有同域名标签页后刷新<br>' +
        '3. 按 F12 查看 Console 中的详细错误信息</p></div>';
    }
  }

  // 启动
  init();

})();
