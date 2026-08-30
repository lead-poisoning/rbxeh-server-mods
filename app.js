// ================================== CONFIG ==================================
const CONFIG = {
  owner: "lead-poisoning",
  repo: "rbxeh-server-mods",
  branch: "main",
  modsFolder: "mods",
  newModsFolder: "new_mods",
  zipFilename: "server-mods.zip",
};
// =============================================================================

const state = {
  fileBuffers: {}, // filename -> ArrayBuffer (cached so the zip button doesn't refetch)
};

init();

async function init() {
  const [modsFiles, newModsFiles] = await Promise.all([
    listFolder(CONFIG.modsFolder),
    listFolder(CONFIG.newModsFolder),
  ]);

  if (modsFiles === null && newModsFiles === null) {
    showError("Couldn't load the mod list from GitHub right now. Try refreshing in a minute.");
    return;
  }

  const allFiles = [
    ...(newModsFiles || []).map((f) => ({ ...f, isNew: true })),
    ...(modsFiles || []).map((f) => ({ ...f, isNew: false })),
  ];

  if (allFiles.length === 0) {
    document.getElementById("status-text").textContent = "No mods uploaded yet.";
    return;
  }

  // Fetch every file's bytes (same-origin — these are served by this same GitHub Pages site)
  const withBuffers = await Promise.all(
    allFiles.map(async (f) => {
      const buffer = await fetchFileBuffer(f.isNew ? CONFIG.newModsFolder : CONFIG.modsFolder, f.name);
      if (buffer) state.fileBuffers[f.name] = buffer;
      return { ...f, buffer };
    })
  );

  const usable = withBuffers.filter((f) => f.buffer);

  // Hash everything, then ask Modrinth what they are (2 API calls total, no matter how many mods)
  const hashed = await Promise.all(
    usable.map(async (f) => ({ ...f, hash: await sha1Hex(f.buffer) }))
  );

  const metadataByHash = await lookupModrinthMetadata(hashed.map((f) => f.hash));

  const entries = hashed.map((f) => ({
    filename: f.name,
    isNew: f.isNew,
    meta: metadataByHash[f.hash] || null, // null = not recognized by Modrinth, falls back to filename
  }));

  render(entries);
  wireDownloadButton();
}

// --- GitHub: list files in a folder via the Contents API (metadata only, cheap) ---
async function listFolder(path) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${path}?ref=${CONFIG.branch}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data
      .filter((entry) => entry.type === "file")
      .map((entry) => ({ name: entry.name }));
  } catch {
    return [];
  }
}

// --- Fetch a mod's bytes from this same site (same-origin, no CORS/rate-limit concerns) ---
async function fetchFileBuffer(folder, filename) {
  try {
    const res = await fetch(`${folder}/${encodeURIComponent(filename)}`);
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

async function sha1Hex(buffer) {
  const hashBuffer = await crypto.subtle.digest("SHA-1", buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --- Modrinth: identify files by hash, then fetch project details in bulk ---
async function lookupModrinthMetadata(hashes) {
  const uniqueHashes = [...new Set(hashes)];
  if (uniqueHashes.length === 0) return {};

  let versionsByHash = {};
  try {
    const res = await fetch("https://api.modrinth.com/v2/version_files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hashes: uniqueHashes, algorithm: "sha1" }),
    });
    if (res.ok) versionsByHash = await res.json();
  } catch {
    return {};
  }

  const projectIds = [...new Set(Object.values(versionsByHash).map((v) => v.project_id))];
  if (projectIds.length === 0) return {};

  let projects = [];
  try {
    const res = await fetch(
      `https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(projectIds))}`
    );
    if (res.ok) projects = await res.json();
  } catch {
    // fall through — versions were found but project details failed; entries just show filenames
  }
  const projectsById = Object.fromEntries(projects.map((p) => [p.id, p]));

  const metadataByHash = {};
  for (const [hash, version] of Object.entries(versionsByHash)) {
    const project = projectsById[version.project_id];
    if (project) {
      metadataByHash[hash] = {
        title: project.title,
        slug: project.slug,
        iconUrl: project.icon_url,
        url: `https://modrinth.com/${project.project_type}/${project.slug}`,
      };
    }
  }
  return metadataByHash;
}

// --- Render ---
function render(entries) {
  const newEntries = entries.filter((e) => e.isNew);
  const regularEntries = entries.filter((e) => !e.isNew);

  const newSection = document.getElementById("new-mods-section");
  const newGrid = document.getElementById("new-mods-grid");
  if (newEntries.length > 0) {
    newSection.classList.remove("hidden");
    newGrid.replaceChildren(...newEntries.map((e) => buildCard(e)));
  }

  const modsGrid = document.getElementById("mods-grid");
  if (regularEntries.length > 0) {
    modsGrid.replaceChildren(...regularEntries.map((e) => buildCard(e)));
  } else {
    modsGrid.replaceChildren();
    const p = document.createElement("p");
    p.className = "status-text";
    p.textContent = "Nothing here yet — check New Mods above.";
    modsGrid.appendChild(p);
  }
}

function buildCard(entry) {
  const card = document.createElement("div");
  card.className = "mod-card" + (entry.isNew ? " is-new" : "");

  if (entry.isNew) {
    const flag = document.createElement("span");
    flag.className = "new-flag";
    flag.textContent = "NEW";
    card.appendChild(flag);
  }

  const icon = document.createElement(entry.meta?.iconUrl ? "img" : "div");
  icon.className = "mod-icon" + (entry.meta?.iconUrl ? "" : " placeholder");
  if (entry.meta?.iconUrl) {
    icon.src = entry.meta.iconUrl;
    icon.alt = "";
  } else {
    icon.textContent = "?";
  }
  card.appendChild(icon);

  const info = document.createElement("div");
  info.className = "mod-info";

  const name = document.createElement("p");
  name.className = "mod-name";
  name.textContent = entry.meta?.title || entry.filename;
  info.appendChild(name);

  if (entry.meta) {
    const link = document.createElement("a");
    link.className = "mod-link";
    link.href = entry.meta.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "View on Modrinth ↗";
    info.appendChild(link);
  } else {
    const fname = document.createElement("p");
    fname.className = "mod-filename";
    fname.textContent = entry.filename;
    info.appendChild(fname);
  }

  card.appendChild(info);
  return card;
}

function showError(message) {
  const el = document.getElementById("status-text");
  if (el) {
    el.textContent = message;
    el.classList.add("error");
  }
}

// --- Download button: zip whatever we already fetched ---
function wireDownloadButton() {
  const btn = document.getElementById("download-btn");
  const label = document.getElementById("download-btn-label");

  btn.addEventListener("click", async () => {
    const filenames = Object.keys(state.fileBuffers);
    if (filenames.length === 0) return;

    btn.disabled = true;
    label.textContent = "Zipping…";

    try {
      const zip = new JSZip();
      for (const filename of filenames) {
        zip.file(filename, state.fileBuffers[filename]);
      }
      const blob = await zip.generateAsync({ type: "blob" });

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = CONFIG.zipFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      label.textContent = "⬇ Download failed — try again";
      btn.disabled = false;
      return;
    }

    label.textContent = "⬇ Download All Mods (.zip)";
    btn.disabled = false;
  });
}
