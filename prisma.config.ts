import "dotenv/config";
import { definePrismaConfig } from "prisma/config";
import { defineConfig as ormConfig } from "@prisma/orm-postgres/config";

export default definePrismaConfig({
  skills: {
    agents: ["cursor"],
  },
  orm: ormConfig({
    contract: "./src/prisma/contract.prisma",
    db: {
      connection: process.env.DIRECT_URL ?? process.env.DATABASE_URL!,
    },
  }),
  composer: {
    configPath: "./prisma-composer.config.ts",
  },
});
