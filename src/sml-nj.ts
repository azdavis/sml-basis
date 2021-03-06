import { load } from "cheerio";
import { access, mkdir, writeFile } from "fs/promises";
import fetch from "node-fetch";
import path from "path";
import type { File } from "./types.js";
import {
  breakSmlAcrossLines,
  compact,
  getCleanText,
  getFilesFromDir,
  getUrls,
  htmlOut,
  smlOut,
  toText,
} from "./util.js";

const rootDir = "sml-nj";
const rootUrl = "https://www.smlnj.org/doc/smlnj-lib/";

async function fetchAndWriteFiles(): Promise<File[]> {
  const $ = load(await fetch(rootUrl).then(toText));
  const smlnjLibraryUrls = getUrls($("#toc a"));
  await mkdir(path.join(rootDir, htmlOut), { recursive: true });
  const xs = smlnjLibraryUrls.map(async (url) => {
    const $ = load(await fetch(`${rootUrl}/${url}`).then(toText));
    const dir = path.dirname(url);
    return Promise.all(
      getUrls($("dt a")).map(async (name) => {
        if (name.includes("#")) {
          return undefined;
        }
        const text = await fetch(`${rootUrl}/${dir}/${name}`).then(toText);
        await writeFile(path.join(rootDir, htmlOut, name), text);
        return { name, text };
      }),
    );
  });
  return compact((await Promise.all(xs)).flat());
}

export async function get() {
  try {
    await access(path.join(rootDir, htmlOut));
  } catch {
    await fetchAndWriteFiles();
  }
  const files = await getFilesFromDir(rootDir);
  await mkdir(path.join(rootDir, smlOut), { recursive: true });
  const ps = files.map(async ({ name, text }) => {
    const $ = load(text);
    const lines: string[] = ["(* synopsis *)"];
    breakSmlAcrossLines(lines, getCleanText($("#_synopsis").next()));
    lines.push("(* interface *)");
    breakSmlAcrossLines(lines, getCleanText($("#_interface").next()));
    const smlName = path.basename(name).replace(/\.html$/, ".sml");
    await writeFile(path.join(rootDir, smlOut, smlName), lines.join("\n"));
  });
  await Promise.all(ps);
}
