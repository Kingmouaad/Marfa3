import type { BetterAuthOptions } from "better-auth";
import {
  createAdapterFactory,
  type DBAdapterDebugLogOption,
  type Where,
} from "better-auth/adapters";
import { and, or } from "@prisma/orm-postgres/orm-client";
import type { db as DbClient } from "@/prisma/db";

type Orm = typeof DbClient.orm;

type Prisma8AdapterConfig = {
  usePlural?: boolean;
  debugLogs?: DBAdapterDebugLogOption;
  namespace?: string;
};

type FieldFns = Record<string, ((value?: unknown) => unknown) | undefined>;
type Fields = Record<string, FieldFns | undefined>;

type Query = {
  where: (fn: (fields: Fields) => unknown) => Query;
  select: (...fields: string[]) => Query;
  orderBy: (fn: (fields: Fields) => unknown) => Query;
  limit: (n: number) => Query;
  offset: (n: number) => Query;
  create: (data: unknown) => Promise<Record<string, unknown>>;
  first: () => Promise<Record<string, unknown> | null>;
  all: () => PromiseLike<Record<string, unknown>[]>;
  aggregate: (fn: (a: { count: () => unknown }) => {
    total: unknown;
  }) => Promise<{ total: number }>;
  update: (data: unknown) => Promise<Record<string, unknown> | null>;
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

function toDbValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toDbValue);
  return value;
}

function fromDbValue(value: unknown): unknown {
  if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)
  ) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return value;
}

function mapRow(row: Record<string, unknown> | null) {
  if (!row) return null;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, fromDbValue(value)]),
  );
}

function mapRows(rows: Record<string, unknown>[]) {
  return rows.map((row) => mapRow(row)!);
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
    ...conjunction,
    ...(disjunction.length ? [or(...disjunction)] : []),
  );
}

function resolveModel(
  db: Pick<typeof DbClient, "orm" | "contract">,
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

export function prisma8Adapter(
  db: Pick<typeof DbClient, "orm" | "contract" | "transaction">,
  config: Prisma8AdapterConfig = {},
) {
  return (options: BetterAuthOptions) =>
    createAdapterFactory({
      config: {
        adapterId: "prisma-8",
        adapterName: "Prisma 8 Adapter",
        usePlural: config.usePlural ?? false,
        debugLogs: config.debugLogs ?? false,
        supportsJSON: true,
        supportsArrays: true,
        supportsDates: true,
        supportsBooleans: true,
        supportsUUIDs: true,
        supportsNumericIds: false,
        transaction: false,
      },
      adapter: ({ getFieldName }) => {
        const query = (model: string, where?: Where[]) => {
          const coordinate = resolveModel(db, model, config);
          const collection = getCollection(db.orm, coordinate);
          if (!where?.length) return collection;
          return collection.where((fields) =>
            prismaWhere(
              fields,
              where.map((w) => ({
                ...w,
                field: getFieldName({ model, field: w.field }),
                value: toDbValue(w.value) as Where["value"],
              })),
            ),
          );
        };

        const selectQuery = (q: Query, model: string, select?: string[]) =>
          select?.length
            ? q.select(
                ...select.map((field) => getFieldName({ model, field })),
              )
            : q;

        return {
          async create({ model, data, select }) {
            return mapRow(
              await selectQuery(query(model), model, select).create(
                Object.fromEntries(
                  Object.entries(data as Record<string, unknown>).map(
                    ([k, v]) => [k, toDbValue(v)],
                  ),
                ),
              ),
            ) as typeof data;
          },

          async findOne({ model, where, select }) {
            return mapRow(
              await selectQuery(query(model, where), model, select).first(),
            );
          },

          async findMany({ model, where, limit, offset, sortBy, select }) {
            let q = selectQuery(query(model, where), model, select).limit(
              limit,
            );
            if (offset) q = q.offset(offset);
            if (sortBy) {
              const field = getFieldName({ model, field: sortBy.field });
              q = q.orderBy((fields) =>
                call(
                  fields[field],
                  sortBy.direction === "desc" ? "desc" : "asc",
                ),
              );
            }
            return mapRows(await q.all());
          },

          async count({ model, where }) {
            const result = await query(model, where).aggregate((a) => ({
              total: a.count(),
            }));
            return result.total;
          },

          async update({ model, where, update }) {
            return mapRow(
              await query(model, where).update(
                Object.fromEntries(
                  Object.entries(update as Record<string, unknown>).map(
                    ([k, v]) => [k, toDbValue(v)],
                  ),
                ),
              ),
            );
          },

          updateMany: async ({ model, where, update }) =>
            query(model, where).updateAndCount(
              Object.fromEntries(
                Object.entries(update).map(([k, v]) => [k, toDbValue(v)]),
              ),
            ),

          async delete({ model, where }) {
            await query(model, where).delete();
          },

          deleteMany: async ({ model, where }) =>
            query(model, where).deleteAndCount(),

          options: config,
        };
      },
    })(options);
}
