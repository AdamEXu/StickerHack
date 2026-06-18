import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const ENCODER = path.join(PACKAGE_ROOT, "helpers", "encode_sticker.swift");
const DEFAULT_STICKER_DB = path.join(
  os.homedir(),
  "Library",
  "Group Containers",
  "com.apple.stickersd.group",
  "Stickers",
  "stickers.stickerdb"
);
const STICKER_DB = process.env.STICKERHACK_DB || DEFAULT_STICKER_DB;
const BACKUP_DIR = process.env.STICKERHACK_BACKUP_DIR || path.join(os.homedir(), "Library", "Application Support", "StickerHack", "Backups");
const COCOA_EPOCH_UNIX = 978_307_200;

function usage() {
  return `You need to specify the png/gif you want to convert!
stickerhack ./path/to/sticker.gif --name "Whatever goes here" --max-edge 768

There's some other stuff but it's more advanced, the defaults should work fine.

Some examples:
- stickerhack ./trollface.png --name "Troll"
- stickerhack ./noooo.gif

Only .png and .gif files for now. Maybe I'll add more formats in the future? Or you can make a PR :)
`;
}

function parseArgs(args) {
  const options = {
    input: null,
    name: null,
    maxEdge: 768,
    noUpscale: false,
    resample: "auto"
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--version" || arg === "-v") {
      options.version = true;
    } else if (arg === "--name") {
      index += 1;
      if (index >= args.length) throw new Error("You did --name but then didn't specify a name :(");
      options.name = args[index];
    } else if (arg === "--no-upscale") {
      options.noUpscale = true;
    } else if (arg === "--max-edge") {
      index += 1;
      if (index >= args.length) throw new Error("You did --max-edge but then didn't specify a pixel size :(");
      const maxEdge = Number(args[index]);
      if (!Number.isInteger(maxEdge) || maxEdge < 2) {
        throw new Error("Uhhhh... what? Too small, nope");
      }
      options.maxEdge = maxEdge;
    } else if (arg === "--resample") {
      index += 1;
      if (index >= args.length) throw new Error("Choose between nearest, smooth, or auto");
      if (!["nearest", "smooth", "auto"].includes(args[index])) {
        throw new Error("You HAVE to choose between nearest, smooth, or auto");
      }
      options.resample = args[index];
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option ${arg}`);
    } else if (options.input) {
      throw new Error("You can only put in one image at a time right now, unfortunately. You can put this into any script you want though! Will add this soon, stay tuned!");
    } else {
      options.input = arg;
    }
  }

  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.encoding ?? "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? 1024 * 1024 * 64
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(detail ? `SOMETHING WENT WRONG: ${command} failed: ${detail}` : `SOMETHING WENT WRONG: ${command} failed with exit ${result.status}`);
  }
  return result.stdout;
}

function commandExists(command) {
  const result = spawnSync("/usr/bin/env", ["which", command], { encoding: "utf8" });
  return result.status === 0;
}

function requireCommand(command, reason) {
  if (!commandExists(command)) {
    throw new Error(`Looks like ${command} is required${reason ? ` (${reason})` : ""}`);
  }
}

function expandHome(inputPath) {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function sqlQuote(value) {
  if (value === null || value === undefined) return "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlBlob(hex) {
  return `X'${hex}'`;
}

function sqlite(dbPath, sql) {
  return run("sqlite3", [dbPath], { input: sql });
}

function sqliteScalar(dbPath, sql) {
  return sqlite(dbPath, `.timeout 10000\n${sql};\n`).trim();
}

function cocoaNow() {
  return Date.now() / 1000 - COCOA_EPOCH_UNIX;
}

function timestamp() {
  const date = new Date();
  const pad = (value, length = 2) => String(value).padStart(length, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    "-",
    pad(date.getMilliseconds(), 3)
  ].join("");
}

function backupDatabase(dbPath) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = path.join(BACKUP_DIR, `stickers.stickerdb.${timestamp()}.backup`);
  sqlite(dbPath, `.timeout 10000\n.backup ${sqlQuote(backupPath)}\n`);
  return backupPath;
}

function uuidHex(uuid) {
  return uuid.replaceAll("-", "").toLowerCase();
}

function nextPk(dbPath, table, entityName) {
  const tableMax = Number(sqliteScalar(dbPath, `select coalesce(max(Z_PK), 0) from ${table}`));
  const trackedMax = Number(sqliteScalar(dbPath, `select coalesce((select Z_MAX from Z_PRIMARYKEY where Z_NAME = ${sqlQuote(entityName)}), 0)`));
  return Math.max(tableMax, trackedMax) + 1;
}

function readEncoderOutput(inputPath, options, tempDir) {
  const args = [
    ENCODER,
    "--input",
    inputPath,
    "--output-dir",
    tempDir,
    "--max-edge",
    String(options.maxEdge),
    "--resample",
    options.resample
  ];
  if (options.noUpscale) args.push("--no-upscale");
  const stdout = run("swift", args, { maxBuffer: 1024 * 1024 * 64 });
  return JSON.parse(stdout);
}

function assertEncoderOutput(encoded) {
  if (!encoded || !Array.isArray(encoded.representations) || encoded.representations.length < 1) {
    throw new Error("SOMETHING WENT WRONG: encoder did not return any sticker representations");
  }
  for (const rep of encoded.representations) {
    if (!rep.path || !fs.existsSync(rep.path)) {
      throw new Error(`SOMETHING WENT WRONG: encoder output missing for role ${rep.role}`);
    }
    if (rep.byteCount < 1) {
      throw new Error(`SOMETHING WENT WRONG: encoder produced empty representation for role ${rep.role}`);
    }
    if (rep.uti === "public.heics") {
      const brand = fs.readFileSync(rep.path).subarray(4, 12).toString("ascii");
      if (brand !== "ftypmsf1") {
        throw new Error("SOMETHING WENT WRONG: animated encoder did not produce an msf1 HEIF image sequence");
      }
    }
  }
}

function insertSticker(dbPath, encoded, searchText) {
  const stickerPk = nextPk(dbPath, "ZMANAGEDSTICKER", "ManagedSticker");
  const repStartPk = nextPk(dbPath, "ZMANAGEDREPRESENTATION", "ManagedRepresentation");
  const maxLibraryIndex = Number(sqliteScalar(dbPath, "select coalesce(max(ZLIBRARYINDEX), 0) from ZMANAGEDSTICKER where ZTYPE = 1"));
  const libraryIndex = maxLibraryIndex + 1024;
  const stickerUuid = crypto.randomUUID().toUpperCase();
  const externalUri = `sticker:///user/identifier/${stickerUuid}`;
  const now = cocoaNow();
  const totalBytes = encoded.representations.reduce((sum, rep) => sum + Number(rep.byteCount), 0);

  const statements = [];
  statements.push(".timeout 10000");
  statements.push("pragma foreign_keys=off;");
  statements.push("begin immediate;");
  statements.push(`
insert into ZMANAGEDSTICKER (
  Z_PK, Z_ENT, Z_OPT, ZATTRIBUTIONADAMID, ZBYTECOUNT,
  ZEFFECT, ZTYPE, ZVERSION, ZCREATIONDATE, ZLASTUSEDDATE,
  ZLIBRARYINDEX, ZACCESSIBILITYNAME, ZATTRIBUTIONBUNDLEIDENTIFIER,
  ZATTRIBUTIONNAME, ZEXTERNALURI, ZNAME,
  ZPROMPTPRIMARYLANGUAGEIDENTIFIER, ZSANITIZEDPROMPT,
  ZSEARCHTEXT, ZIDENTIFIER, ZMETADATA
) values (
  ${stickerPk}, 2, 1, 0, ${totalBytes},
  0, 1, 1, ${now}, ${now},
  ${libraryIndex}, null, null,
  null, ${sqlQuote(externalUri)}, '',
  null, null,
  ${sqlQuote(searchText)}, ${sqlBlob(uuidHex(stickerUuid))}, null
);`);

  encoded.representations.forEach((rep, offset) => {
    const repUuid = crypto.randomUUID();
    const repPk = repStartPk + offset;
    statements.push(`
insert into ZMANAGEDREPRESENTATION (
  Z_PK, Z_ENT, Z_OPT, ZBYTECOUNT, ZINDEX, ZISPREFERRED,
  ZVERSION, ZSTICKER, ZSIZE_H, ZSIZE_W, ZROLE, ZUTI,
  ZIDENTIFIER, ZDATA
) values (
  ${repPk}, 1, 1, ${Number(rep.byteCount)}, ${Number(rep.index)}, ${rep.preferred ? 1 : 0},
  1, ${stickerPk}, ${Number(rep.height)}, ${Number(rep.width)}, ${sqlQuote(rep.role)}, ${sqlQuote(rep.uti)},
  ${sqlBlob(uuidHex(repUuid))}, readfile(${sqlQuote(rep.path)})
);`);
  });

  statements.push(`update Z_PRIMARYKEY set Z_MAX = ${stickerPk} where Z_NAME = 'ManagedSticker';`);
  statements.push(`update Z_PRIMARYKEY set Z_MAX = ${repStartPk + encoded.representations.length - 1} where Z_NAME = 'ManagedRepresentation';`);
  statements.push("commit;");

  sqlite(dbPath, statements.join("\n"));
  return {
    stickerPk,
    externalUri,
    libraryIndex,
    totalBytes,
    repStartPk,
    repEndPk: repStartPk + encoded.representations.length - 1
  };
}

function restartStickersd() {
  if (process.env.STICKERHACK_NO_RESTART === "1") return false;
  spawnSync("killall", ["stickersd"], { encoding: "utf8" });
  return true;
}

function printSummary(inputPath, encoded, inserted, backupPath, name) {
  const repSummary = encoded.representations
    .map((rep) => `${rep.role.replace("com.apple.stickers.role.", "")}/${rep.uti} ${rep.width}x${rep.height} ${rep.byteCount} bytes`)
    .join(", ");
  console.log(name ? `Imported ${path.basename(inputPath)} successfully, and you named it ${name}.` : `Imported ${path.basename(inputPath)} successfully!`);
  if (process.env.STICKERHACK_NO_RESTART === "1") {
    console.log("Since you specified to not restart stickersd, it was not restarted. Restart Messages to see the new sticker.");
  } else {
    console.log("Your sticker is ready to use! Find it in the iMessage emoji picker :) If you encountered any issues, please create a github issue :)");
  }
}

export async function main(args) {
  const options = parseArgs(args);
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.version) {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
    console.log(pkg.version);
    return;
  }
  if (!options.input) {
    console.log(usage());
    throw new Error("You need to specify an image path :) Relative or absolute both work. One image at a time btw");
  }
  if (process.platform !== "darwin") {
    throw new Error("StickerHack only works on mac, just like imessage. womp womp");
  }
  requireCommand("swift", "needed for encoding. How'd you even install this without the xcode developer tools? Pretty sure npm/whatever needs those");
  requireCommand("sqlite3", "needed to write the sticker database. macOS literally ships with this and it's like pretty essential and stuff.");

  const inputPath = path.resolve(expandHome(options.input));
  if (!fs.existsSync(inputPath)) {
    throw new Error(`The image you specified was not found. Did you misspell it? ${inputPath} btw in zsh (default on macos) you can tab to autocomplete file name. You can also drag in the file in most terminals`);
  }
  if (!fs.existsSync(STICKER_DB)) {
    throw new Error(`The sticker database was not found. I've personally never encountered this before. Maybe make a sticker the official route first and then try this? Or maybe open imessage on your mac and set that up if you didn't before? Docs on how to get your first sticker (idk if this is needed, it might be?): https://support.apple.com/guide/iphone/make-stickers-from-your-photos-iph9b4106303/26/ios/26`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stickerhack-"));
  try {
    const encoded = readEncoderOutput(inputPath, options, tempDir);
    assertEncoderOutput(encoded);
    const backupPath = backupDatabase(STICKER_DB);
    const inserted = insertSticker(STICKER_DB, encoded, options.name);
    restartStickersd();
    printSummary(inputPath, encoded, inserted, backupPath, options.name);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
