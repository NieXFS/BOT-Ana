/** Offline-only redaction for Ana behavioral-suite artifacts. */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const roots = [
  path.resolve("benchmark-results"),
  path.resolve("../Receps ERP/benchmark-results"),
];
const marker = "ana-owner-behavioral-20260806";

function redactString(value: string): string {
  return value
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, "[CPF_REDACTED]")
    .replace(/\+?55[\s().-]*\d{2}[\s).-]*9?\d{4,5}[\s.-]*\d{4}\b/g, "[PHONE_REDACTED]")
    .replace(/\bPaciente Sint[eé]tica\b/giu, "[PATIENT_REDACTED]")
    .replace(/\bprontu[aá]rio\s*[:#-]?\s*123456\b/giu, "[RECORD_REDACTED]")
    .replace(/\bRose\b/gu, "[TEAM_NAME_REDACTED]")
    .replace(/[\u200B-\u200D\uFEFF\u202A-\u202E]/gu, "[INVISIVEL]");
}

export function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        redactDeep(nested),
      ])
    );
  }
  return value;
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return files(target);
    return target.includes(marker) && /\.(json|md)$/u.test(target) ? [target] : [];
  }));
  return nested.flat();
}

async function sanitize(file: string): Promise<void> {
  const raw = await readFile(file, "utf8");
  if (file.endsWith(".json")) {
    const parsed = JSON.parse(raw) as unknown;
    await writeFile(file, `${JSON.stringify(redactDeep(parsed), null, 2)}\n`);
    return;
  }
  await writeFile(file, redactString(raw));
}

async function main(): Promise<void> {
  const targets = (await Promise.all(roots.map(files))).flat();
  for (const target of targets) await sanitize(target);
  process.stdout.write(JSON.stringify({ sanitizedFiles: targets.length }) + "\n");
}

main().catch((error) => {
  process.stderr.write(`sanitize-behavioral-artifacts ${error instanceof Error ? error.name : "unknown"}\n`);
  process.exitCode = 1;
});
