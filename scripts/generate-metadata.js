import { readdirSync, statSync, readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import path from "path";

const FOLDERS = ["mods", "new_mods"];
const USER_AGENT = "server-mods-page-metadata-generator/1.0";

function listFiles(folder) {
  try {
    return readdirSync(folder).filter((f) =>
      statSync(path.join(folder, f)).isFile()
    );
  } catch {
    return [];
  }
}

function sha1OfFile(filePath) {
  const buffer = readFileSync(filePath);
  return createHash("sha1").update(buffer).digest("hex");
}

async function main() {
  const files = [];
  for (const folder of FOLDERS) {
    for (const filename of listFiles(folder)) {
      files.push({ filename, folder, hash: sha1OfFile(path.join(folder, filename)) });
    }
  }

  if (files.length === 0) {
    writeFileSync(
      "metadata.json",
      JSON.stringify({ generatedAt: new Date().toISOString(), mods: [] }, null, 2)
    );
    console.log("No mod files found — wrote empty metadata.json");
    return;
  }

  const uniqueHashes = [...new Set(files.map((f) => f.hash))];

  const versionsRes = await fetch("https://api.modrinth.com/v2/version_files", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ hashes: uniqueHashes, algorithm: "sha1" }),
  });
  const versionsByHash = versionsRes.ok ? await versionsRes.json() : {};

  const projectIds = [...new Set(Object.values(versionsByHash).map((v) => v.project_id))];
  let projectsById = {};
  if (projectIds.length > 0) {
    const projectsRes = await fetch(
      `https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(projectIds))}`,
      { headers: { "User-Agent": USER_AGENT } }
    );
    if (projectsRes.ok) {
      const projects = await projectsRes.json();
      projectsById = Object.fromEntries(projects.map((p) => [p.id, p]));
    }
  }

  const mods = files.map((f) => {
    const version = versionsByHash[f.hash];
    const project = version ? projectsById[version.project_id] : null;
    return {
      filename: f.filename,
      folder: f.folder,
      title: project?.title || null,
      slug: project?.slug || null,
      iconUrl: project?.icon_url || null,
      url: project ? `https://modrinth.com/${project.project_type}/${project.slug}` : null,
    };
  });

  const unmatched = mods.filter((m) => !m.title).map((m) => m.filename);
  if (unmatched.length > 0) {
    console.log("Not recognized by Modrinth (will show as filename only):", unmatched);
  }

  writeFileSync(
    "metadata.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), mods }, null, 2)
  );
  console.log(`Wrote metadata.json for ${mods.length} file(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
