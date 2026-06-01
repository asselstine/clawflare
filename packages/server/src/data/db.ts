import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.js";

type MinimalD1PreparedStatement = D1PreparedStatement & {
  raw?: () => Promise<unknown[][]>;
};

function ensureRawSupport(d1: D1Database): D1Database {
  return new Proxy(d1, {
    get(target, prop, receiver) {
      if (prop !== "prepare") {
        return Reflect.get(target, prop, receiver);
      }

      return (query: string) => {
        const statement = target.prepare(query) as MinimalD1PreparedStatement;
        return new Proxy(statement, {
          get(stmtTarget, stmtProp, stmtReceiver) {
            if (stmtProp === "bind") {
              return (...values: unknown[]) => {
                const bound = stmtTarget.bind(...values) as MinimalD1PreparedStatement;
                return addRawFallback(bound);
              };
            }

            return Reflect.get(stmtTarget, stmtProp, stmtReceiver);
          },
        });
      };
    },
  });
}

function addRawFallback(statement: MinimalD1PreparedStatement): MinimalD1PreparedStatement {
  if (typeof statement.raw === "function") {
    return statement;
  }

  return new Proxy(statement, {
    get(target, prop, receiver) {
      if (prop === "raw") {
        return async () => {
          const result = await target.all();
          return (result.results ?? []).map((row) => Object.values(row));
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

export function createDb(d1: D1Database) {
  return drizzle(ensureRawSupport(d1), { schema });
}

export type Db = ReturnType<typeof createDb>;
export { schema };
