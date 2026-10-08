// 시험용 메모리 DB — firestore.js restDb와 같은 인터페이스. 실제 Firestore는 건드리지 않는다.
export function fakeDb(seed = {}) {
  const store = new Map();   // path → data
  for (const [path, data] of Object.entries(seed)) store.set(path, structuredClone(data));
  const docsIn = (col) => [...store.entries()]
    .filter(([p]) => p.startsWith(col + '/') && p.split('/').length === 2)
    .map(([path, data]) => ({ id: path.split('/')[1], path, data: structuredClone(data) }));
  const cmp = { '==': (a, b) => a === b, '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '<': (a, b) => a < b };
  function query(col, filters = [], opts = {}) {
    let rows = docsIn(col).filter(d => filters.every(([f, op, v]) => d.data[f] !== undefined && cmp[op](d.data[f], v)));
    if (opts.orderBy) {
      const [f, dir] = opts.orderBy;
      rows = rows.filter(d => d.data[f] !== undefined && d.data[f] !== null);
      rows.sort((a, b) => (a.data[f] > b.data[f] ? 1 : a.data[f] < b.data[f] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
    }
    if (opts.limit) rows = rows.slice(0, opts.limit);
    return rows;
  }
  const get = (path) => store.has(path) ? { id: path.split('/').pop(), path, data: structuredClone(store.get(path)) } : null;
  let commits = 0;
  return {
    store,
    get commits() { return commits; },
    get: async (p) => get(p),
    query: async (c, f, o) => query(c, f, o),
    list: async (c) => docsIn(c),
    async transaction(fn) {
      const writes = [];
      const tx = {
        get: async (p) => get(p),
        query: async (c, f, o) => query(c, f, o),
        create: (p, d) => writes.push(['create', p, d]),
        set: (p, d) => writes.push(['set', p, d]),
        update: (p, d) => writes.push(['update', p, d]),
      };
      const result = await fn(tx);
      for (const [op] of writes) if (!op) throw new Error('bad');
      for (const [op, p] of writes) {           // 전부 검사한 뒤 한꺼번에 반영 (원자성)
        if (op === 'create' && store.has(p)) throw new Error('이미 있는 문서: ' + p);
        if (op === 'update' && !store.has(p)) throw new Error('없는 문서: ' + p);
      }
      for (const [op, p, d] of writes) {
        if (op === 'update') store.set(p, Object.assign(store.get(p), structuredClone(d)));
        else store.set(p, structuredClone(d));
      }
      if (writes.length) commits++;
      return result;
    },
  };
}
