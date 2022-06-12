import { Cheerio, load, type CheerioAPI, type Element } from "cheerio";
import { readdir, readFile, writeFile } from "fs/promises";
import fetch from "node-fetch";
import path from "path";

const rootUrl = "https://smlfamily.github.io/Basis";

const outDir = "html";

function assert(x: boolean) {
  if (!x) {
    throw new Error("assert failed");
  }
}

function filterMap<T, U>(f: (x: T) => U | undefined, xs: T[]): U[] {
  const ret = [];
  for (const x of xs) {
    const res = f(x);
    if (res !== undefined) {
      ret.push(res);
    }
  }
  return ret;
}

function id<T>(x: T): T {
  return x;
}

async function fetchAndWriteFiles(): Promise<File[]> {
  const resp = await fetch(`${rootUrl}/manpages.html`);
  const text = await resp.text();
  const body = load(text);
  const urls = filterMap(
    id,
    body("h4 a")
      .toArray()
      .map((x) => x.attribs["href"]),
  );
  return Promise.all(
    urls.map(async (name) => {
      const resp = await fetch(`${rootUrl}/${name}`);
      const text = await resp.text();
      await writeFile(path.join(outDir, name), text);
      return { name, text };
    }),
  );
}

interface File {
  name: string;
  text: string;
}

function processFiles(files: File[]): MergedInfo[] {
  return files.map((file) => {
    const name = file.name.replace(/\.html$/, "");
    const info = getInfo(file.name, load(file.text));
    const merged = mergeDecsAndDefs(info.sigDecs, info.defs);
    return {
      signatureName: info.signatureName,
      otherNames: info.otherNames,
      desc: info.desc,
      defs: merged.defs,
      unused: merged.unused,
    };
  });
}

interface MultiDef {
  items: string[];
  desc: string;
}

interface Info {
  signatureName: string | null;
  otherNames: string[];
  desc: string[];
  sigDecs: string[];
  defs: MultiDef[];
}

function getCleanText(x: Cheerio<Element>): string {
  // \s includes regular space, non-breaking space, newline, and others
  return x.text().trim().replaceAll(/\s+/g, " ");
}

const decStart = new Set([
  "type",
  "eqtype",
  "datatype",
  "exception",
  "val",
  "structure",
  "signature",
  "functor",
]);

function breakSmlAcrossLines(text: string): string[] {
  const ret: string[] = [];
  const tokens = text.split(" ");
  let cur: string[] = [];
  let prev: string | null = null;
  for (const token of tokens) {
    // hack to not split on 'where type' or 'and type' or 'sharing type'
    if (
      decStart.has(token) &&
      (token !== "type" ||
        prev === null ||
        (prev !== "where" && prev !== "and" && prev !== "sharing"))
    ) {
      if (cur.length !== 0) {
        ret.push(cur.join(" "));
      }
      cur = [token];
    } else {
      cur.push(token);
    }
    prev = token;
  }
  ret.push(cur.join(" "));
  return ret;
}

function getInfo(name: string, $: CheerioAPI): Info {
  const headers = $("h4").toArray();
  const synopsisHeader = headers.find((x) => getCleanText($(x)) == "Synopsis");
  const desc: string[] = [];
  let signatureName: string | null = null;
  let otherNames: string[] = [];
  if (synopsisHeader === undefined) {
    console.warn(`${name}: missing synopsis`);
  } else {
    let cur = $(synopsisHeader).next();
    assert(cur.length === 1 && cur.is("blockquote"));
    const synopsis = breakSmlAcrossLines(getCleanText(cur));
    const fst = synopsis.shift();
    if (fst === undefined) {
      throw new Error("empty synopsis");
    }
    if (fst.split(" ")[0] === "signature") {
      signatureName = fst;
    } else {
      console.warn(`${name}: missing signature in synopsis`);
    }
    otherNames = synopsis;
    for (;;) {
      cur = cur.next();
      assert(cur.length === 1);
      if (cur.is("p")) {
        desc.push(getCleanText(cur));
      } else if (cur.is("hr")) {
        break;
      } else {
        console.warn(`${name}: non-p non-hr in synopsis, ignoring`);
      }
    }
  }
  const interfaceHeader = headers.find(
    (x) => getCleanText($(x)) == "Interface",
  );
  let sigDecs: string[] = [];
  if (interfaceHeader === undefined) {
    console.warn(`${name}: missing interface`);
  } else {
    const elem = $(interfaceHeader).next();
    assert(elem.length === 1 && elem.is("blockquote"));
    sigDecs = breakSmlAcrossLines(getCleanText(elem));
  }
  const descriptionHeader = headers.find(
    (x) => getCleanText($(x)) == "Description",
  );
  const defs: MultiDef[] = [];
  if (descriptionHeader === undefined) {
    console.warn(`${name}: missing description`);
  } else {
    const descriptionDl = $(descriptionHeader).next();
    assert(descriptionDl.length === 1 && descriptionDl.is("dl"));
    let items: string[] = [];
    for (const ch of descriptionDl.children().toArray()) {
      const child = $(ch);
      if (child.is("dt")) {
        const t = getCleanText(child);
        if (t.length !== 0) {
          items.push(t);
        }
      } else if (child.is("dd")) {
        defs.push({ items, desc: getCleanText(child) });
        items = [];
      } else {
        console.warn(`${name}: non-dt non-dd child in description, ignoring`);
      }
    }
    assert(items.length === 0);
  }
  return {
    signatureName,
    otherNames,
    desc,
    sigDecs,
    defs,
  };
}

interface MergedInfo {
  signatureName: string | null;
  otherNames: string[];
  desc: string[];
  defs: Def[];
  unused: { [k: string]: string };
}

interface Def {
  dec: string;
  prose: string | null;
}

function getName(s: string): string {
  const name = s.split(" ").find((x) => !decStart.has(x) && !x.startsWith("'"));
  if (name === undefined) {
    throw new Error(`couldn't get name for: ${s}`);
  }
  return name;
}

interface Merged {
  defs: Def[];
  unused: { [k: string]: string };
}

function mergeDecsAndDefs(sigDecs: string[], multiDefs: MultiDef[]): Merged {
  const map = new Map<string, string>();
  const used = new Set<string>();
  for (const def of multiDefs) {
    assert(def.items.length !== 0);
    const fst = def.items[0];
    const fstName = getName(fst);
    if (def.items.length === 1) {
      let desc: string;
      if (decStart.has(fst.split(" ")[0])) {
        desc = def.desc;
      } else {
        desc = def.items[0] + " " + def.desc;
      }
      map.set(fstName, desc);
    } else {
      map.set(fstName, def.desc);
      for (let i = 1; i < def.items.length; i++) {
        const name = getName(def.items[i]);
        map.set(name, `See ${fstName}.`);
      }
    }
  }
  const defs = sigDecs.map((dec) => {
    const name = getName(dec);
    const val = map.get(name);
    used.add(name);
    return { dec, prose: val === undefined ? null : val };
  });
  const unused: { [k: string]: string } = {};
  for (const [k, v] of map.entries()) {
    if (!used.has(k)) {
      unused[k] = v;
    }
  }
  return { defs, unused };
}

async function getFilesFromDir(): Promise<File[]> {
  const fileNames = await readdir(outDir);
  return Promise.all(
    fileNames.map((name) =>
      readFile(path.join(outDir, name)).then((text) => ({
        name,
        text: text.toString(),
      })),
    ),
  );
}

async function main() {
  // await fetchAndWriteFiles();
  const files = await getFilesFromDir();
  const info = processFiles(files);
  await writeFile("out.json", JSON.stringify(info, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
