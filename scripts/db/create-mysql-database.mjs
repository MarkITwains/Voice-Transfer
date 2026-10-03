/**
 * 幂等建库脚本：连接 DATABASE_URL 指向的 MySQL 实例，
 * 若目标库不存在则创建（utf8mb4），并验证账号可连通、可读写。
 *
 * 用法（项目根目录执行）：
 *   node scripts/db/create-mysql-database.mjs
 *
 * 表结构由应用启动时的 bootstrap 自动创建，无需在此维护 DDL。
 */
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";

const envPath = path.join(process.cwd(), ".env.local");
if (!fs.existsSync(envPath)) {
    console.error("[create-mysql-database] 未找到 .env.local，请先按 .env.example 配置");
    process.exit(1);
}
const envLine = fs
    .readFileSync(envPath, "utf-8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("DATABASE_URL="));
if (!envLine) {
    console.error("[create-mysql-database] .env.local 中未找到 DATABASE_URL");
    process.exit(1);
}

const url = new URL(envLine.slice("DATABASE_URL=".length).trim());
const dbName = decodeURIComponent(url.pathname.replace(/^\//, ""));
if (!/^[A-Za-z0-9_]+$/.test(dbName)) {
    console.error(`[create-mysql-database] 库名不合法: ${dbName}`);
    process.exit(1);
}

const baseConfig = {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    connectTimeout: 10_000,
};

// 1. 不带库名连接，探测实例可达性 + 创建库（幂等）
const server = await mysql.createConnection(baseConfig);
try {
    const [verRows] = await server.query("SELECT VERSION() AS v");
    console.log(`[create-mysql-database] 实例可达，MySQL 版本: ${verRows[0].v}`);
    await server.query(
        `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    console.log(`[create-mysql-database] 数据库就绪: ${dbName}`);
} finally {
    await server.end();
}

// 2. 带库名连接，验证账号可读写
const db = await mysql.createConnection({ ...baseConfig, database: dbName });
try {
    const [rows] = await db.query("SELECT 1 AS ok");
    console.log(`[create-mysql-database] 连通验证通过: ${dbName} → SELECT 1 = ${rows[0].ok}`);
} finally {
    await db.end();
}
console.log("[create-mysql-database] 完成。表结构将由应用启动时自动创建。");
