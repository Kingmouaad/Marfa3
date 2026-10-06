import type { BetterAuthOptions } from "better-auth";
import {
  createAdapterFactory,
  type AdapterFactoryOptions,
  type DBAdapterDebugLogOption,
  type Where,
} from "better-auth/adapters";
import { and, or } from "@prisma/orm-postgres/orm-client";
import type { db as DbClient } from "@/prisma/db";

type Db = typeof DbClient;
type Orm = Db["orm"];

type Prisma8AdapterConfig = {
  usePlural?: boolean;
  debugLogs?: DBAdapterDebugLogOption;
  namespace?: string;
  /** Run Better Auth's multi-statement flows (e.g. sign-up) atomically. Defaults to true. */
  transaction?: boolean;
};

type Row = Record<string, unknown>;
type FieldFns = Record<string, ((value?: unknown) => unknown) | undefined>;
type Fields = Record<string, FieldFns | undefined>;

type Query = {
  where: (fn: (fields: Fields) => unknown) => Query;
  select: (...fields: string[]) => Query;
  orderBy: (fn: (fields: Fields) => unknown) => Query;
  limit: (n: number) => Query;
  offset: (n: number) => Query;
  create: (data: unknown) => Promise<Row>;
  first: () => Promise<Row | null>;
  all: () => PromiseLike<Row[]>;
  aggregate: (fn: (a: { count: () => unknown }) => {
    total: unknown;
  }) => Promise<{ total: number }>;
  update: (data: unknown) => Promise<Row | null>;
  updateAndCount: (data: unknown) => Promise<number>;
  delete: () => Promise<unknown>;
  deleteAndCount: () => Promise<number>;
};

const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");

function call(field: FieldFns | undefined, method: string, value?: unknown) {
  const fn = field?.[method];
  if (!fn) {
    throw new Error(
      `Prisma 8 field does not support ${method}; check the field name and codec traits.`,
    );
  }
  return fn(value);
}

// Better Auth converts scalar Dates itself (supportsDates: false); this covers
// Dates inside `in` / `not_in` arrays, which the factory passes through as-is.
function toDbValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toDbValue);
  return value;
}

/** Better Auth AND-group + OR-group semantics → Prisma 8 predicates. */
export function prismaWhere(fields: Fields, where: readonly Where[] = []) {
  function condition(w: Where) {
    const field = fields[w.field];
    const op = w.operator ?? "eq";
    const value = toDbValue(w.value);

    if (value === null && (op === "eq" || op === "ne")) {
      return call(field, op === "eq" ? "isNull" : "isNotNull");
    }

    if (op === "in" || op === "not_in") {
      if (!Array.isArray(value)) throw new Error(`${op} requires an array`);
      const values = value.filter((v) => v != null);
      if (!values.length) return op === "in" ? or() : and();
      return call(field, op === "in" ? "in" : "notIn", values);
    }

    if (op === "contains" || op === "starts_with" || op === "ends_with") {
      if (typeof value !== "string") throw new Error(`${op} requires a string`);
      const pattern = `${op === "starts_with" ? "" : "%"}${escapeLike(value)}${op === "ends_with" ? "" : "%"}`;
      const method = w.mode === "insensitive" ? "ilike" : "like";
      return call(field, method, pattern);
    }

    const method = op === "ne" ? "neq" : op;
    return call(field, method, value);
  }

  const conjunction = where
    .filter((w) => w.connector !== "OR")
    .map(condition);
  const disjunction = where
    .filter((w) => w.connector === "OR")
    .map(condition);

  return and(
    ...(conjunction as Parameters<typeof and>),
    ...(disjunction.length
      ? [or(...(disjunction as Parameters<typeof or>))]
      : []),
  );
}

function resolveModel(
  db: Pick<Db, "contract">,
  name: string,
  config: Prisma8AdapterConfig,
): { namespace: string; model: string } {
  const namespaces = db.contract.domain.namespaces as Record<
    string,
    { models?: Record<string, unknown> }
  >;

  const candidates = Object.entries(namespaces).flatMap(([ns, domain]) => {
    if (config.namespace !== undefined && ns !== config.namespace) return [];
    return Object.keys(domain.models ?? {}).map((model) => ({
      namespace: ns,
      model,
    }));
  });

  const exact = candidates.filter((c) => c.model === name);
  const matches = exact.length
    ? exact
    : candidates.filter(
        (c) => c.model[0]?.toLowerCase() + c.model.slice(1) === name,
      );

  if (matches.length !== 1) {
    throw new Error(
      `Prisma 8 model '${name}' ${matches.length ? "is ambiguous" : "was not found"}.`,
    );
  }

  return matches[0]!;
}

function getCollection(
  orm: Orm,
  coordinate: { namespace: string; model: string },
): Query {
  const surface = orm as unknown as Record<string, Record<string, Query>>;
  const collection = surface[coordinate.namespace]?.[coordinate.model];
  if (!collection) {
    throw new Error(
      `Prisma 8 collection ${coordinate.namespace}.${coordinate.model} is unavailable`,
    );
  }
  return collection;
}

function createAdapter(
  db: Pick<Db, "contract">,
  orm: Orm,
  config: Prisma8AdapterConfig,
): AdapterFactoryOptions["adapter"] {
  return ({ getFieldName }) => {
    const collection = (model: string) =>
      getCollection(orm, resolveModel(db, model, config));

    // Always attach a `.where()`: Prisma 8 write terminals require one, and an
    // empty Better Auth `where` means "every row" (`and()` with no operands).
    const query = (model: string, where: readonly Where[] = []) =>
      collection(model).where((fields) =>
        prismaWhere(
          fields,
          where.map((w) => ({
            ...w,
            field: getFieldName({ model, field: w.field }),
          })),
        ),
      );

    const selectQuery = (q: Query, model: string, select?: string[]) =>
      select?.length
        ? q.select(...select.map((field) => getFieldName({ model, field })))
        : q;

    return {
      async create({ model, data, select }) {
        return (await selectQuery(collection(model), model, select).create(
          data,
        )) as typeof data;
      },

      async findOne<T>({
        model,
        where,
        select,
      }: {
        model: string;
        where: Where[];
        select?: string[];
      }) {
        return (await selectQuery(
          query(model, where),
          model,
          select,
        ).first()) as T | null;
      },

      async findMany<T>({
        model,
        where,
        limit,
        offset,
        sortBy,
        select,
      }: {
        model: string;
        where?: Where[];
        limit: number;
        select?: string[];
        sortBy?: { field: string; direction: "asc" | "desc" };
        offset?: number;
      }) {
        let q = selectQuery(query(model, where), model, select);
        if (sortBy) {
          const field = getFieldName({ model, field: sortBy.field });
          q = q.orderBy((fields) =>
            call(fields[field], sortBy.direction === "desc" ? "desc" : "asc"),
          );
        }
        q = q.limit(limit);
        if (offset) q = q.offset(offset);
        return (await q.all()) as T[];
      },

      async count({ model, where }) {
        const result = await query(model, where).aggregate((a) => ({
          total: a.count(),
        }));
        return result.total;
      },

      async update<T>({
        model,
        where,
        update,
      }: {
        model: string;
        where: Where[];
        update: T;
      }) {
        return (await query(model, where).update(update)) as T | null;
      },

      updateMany: ({ model, where, update }) =>
        query(model, where).updateAndCount(update),

      async delete({ model, where }) {
        await query(model, where).delete();
      },

      deleteMany: ({ model, where }) => query(model, where).deleteAndCount(),

      options: config,
    };
  };
}

export function prisma8Adapter(
  db: Pick<Db, "orm" | "contract" | "transaction">,
  config: Prisma8AdapterConfig = {},
) {
  let lazyOptions: BetterAuthOptions | null = null;

  const factoryConfig: AdapterFactoryOptions["config"] = {
    adapterId: "prisma-8",
    adapterName: "Prisma 8 Adapter",
    usePlural: config.usePlural ?? false,
    debugLogs: config.debugLogs ?? false,
    // The contract has no JSON or array columns; let Better Auth serialise them.
    supportsJSON: false,
    supportsArrays: false,
    // Timestamp columns use the `TimestamptzString` codec (strings in and out),
    // so Better Auth converts Date <-> string using its own field types.
    supportsDates: false,
    supportsBooleans: true,
    supportsUUIDs: true,
    supportsNumericIds: false,
    transaction:
      config.transaction === false
        ? false
        : (cb) =>
            db.transaction((tx) =>
              cb(
                createAdapterFactory({
                  config: { ...factoryConfig, transaction: false },
                  adapter: createAdapter(db, tx.orm as Orm, config),
                })(lazyOptions!),
              ),
            ),
  };

  const adapter = createAdapterFactory({
    config: factoryConfig,
    adapter: createAdapter(db, db.orm, config),
  });

  return (options: BetterAuthOptions) => {
    lazyOptions = options;
    return adapter(options);
  };
}
