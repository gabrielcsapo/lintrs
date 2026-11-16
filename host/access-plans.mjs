const fields = new Set([
  "name",
  "declarations",
  "valueDeclaration",
  "checkFlags",
]);

export function createAccessPlans() {
  let activeRule;
  let origins = new WeakMap();
  let observations = new Map();
  const history = new Map();
  const stats = { fusedQueries: 0, fusedFields: 0, usedFields: 0 };
  const keyFor = (query, kind) =>
    activeRule === undefined
      ? undefined
      : JSON.stringify([activeRule, query, kind]);

  return {
    stats,
    withRule(rule, action) {
      const previous = activeRule;
      activeRule = rule;
      try {
        return action();
      } finally {
        activeRule = previous;
      }
    },
    fields(query, kind) {
      const record = history.get(keyFor(query, kind));
      if (record === undefined || record.queries < 8) return [];
      return [...record.reads]
        .filter(([, count]) => count / record.queries >= 0.8)
        .map(([field]) => field);
    },
    observe(object, query, kind) {
      if (object === undefined || query !== "getSymbolAtLocation") return;
      const key = keyFor(query, kind);
      if (key === undefined) return;
      let rules = origins.get(object);
      if (rules === undefined) {
        rules = new Map();
        origins.set(object, rules);
      }
      if (rules.has(activeRule)) return;
      rules.set(activeRule, { key, reads: new Set() });
      let record = observations.get(key);
      if (record === undefined) {
        record = { queries: 0, reads: new Map() };
        observations.set(key, record);
      }
      record.queries++;
    },
    read(object, field) {
      if (!fields.has(field)) return;
      const origin = origins.get(object)?.get(activeRule);
      if (origin === undefined || origin.reads.has(field)) return;
      origin.reads.add(field);
      const record = observations.get(origin.key);
      record.reads.set(field, (record.reads.get(field) ?? 0) + 1);
    },
    finishFile() {
      for (const [key, record] of observations) {
        let previous = history.get(key);
        if (previous === undefined) {
          previous = { queries: 0, reads: new Map() };
          history.set(key, previous);
        }
        previous.queries += record.queries;
        for (const [field, count] of record.reads)
          previous.reads.set(field, (previous.reads.get(field) ?? 0) + count);
      }
      origins = new WeakMap();
      observations = new Map();
    },
  };
}
