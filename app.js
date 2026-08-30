const CONFIG = {
  metadataUrl: "metadata.json",
  zipFilename: "server-mods.zip",
};

init();

async function init() {
  let data;
  try {
    const res = await fetch(CONFIG.metadataUrl, { cache: "no-store" });
    if (!res.ok) throw new Error("not found");
    data = await res.json();
  } catch {
    showError("Couldn't load metadata.json — has the update-metadata Action run yet?");
    return;
  }

  const mods = data.mods || [];
  if (mods.length === 0) {
    document.getElementById("status-text").textContent = "No mods uploaded yet.";
    return;
  }

  render(mods);
  wireDownloadButton(mods);
}

function render(mods) {
  const newEntries = mods.filter((m) => m.folder === "new_mods");
  const regularEntries = mods.filter((m) => m.folder !== "new_mods");

  const newSection = document.getElementById("new-mods-section");
  const newGrid = document.getElementById("new-mods-grid");
  if (newEntries.length > 0) {
    newSection.classList.remove("hidden");
    newGrid.replaceChildren(...newEntries.map((m) => buildCard(m, true)));
  }

  const modsGrid = document.getElementById("mods-grid");
  if (regularEntries.length > 0) {
    modsGrid.replaceChildren(...regularEntries.map((m) => buildCard(m, false)));
  } else {
    const p = document.createElement("p");
    p.className = "status-text";
    p.textContent = "Nothing here yet — check New Mods above.";
    modsGrid.replaceChildren(p);
  }
}

function buildCard(mod, isNew) {
  const card = document.createElement("div");
  card.className = "mod-card" + (isNew ? " is-new" : "");

  if (isNew) {
    const flag = document.createElement("span");
    flag.className = "new-flag";
    flag.textContent = "NEW";
    card.appendChild(flag);
  }

  const icon = document.createElement(mod.iconUrl ? "img" : "div");
  icon.className = "mod-icon" + (mod.iconUrl ? "" : " placeholder");
  if (mod.iconUrl) {
    icon.src = mod.iconUrl;
    icon.alt = "";
  } else {
    icon.textContent = "?";
  }
  card.appendChild(icon);

  const info = document.createElement("div");
  info.className = "mod-info";

  const name = document.createElement("p");
  name.className = "mod-name";
  name.textContent = mod.title || mod.filename;
  info.appendChild(name);

  if (mod.url) {
    const link = document.createElement("a");
    link.className = "mod-link";
    link.href = mod.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "View on Modrinth ↗";
    info.appendChild(link);
  } else {
    const fname = document.createElement("p");
    fname.className = "mod-filename";
    fname.textContent = mod.filename;
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

function wireDownloadButton(mods) {
  const btn = document.getElementById("download-btn");
  const label = document.getElementById("download-btn-label");

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const zip = new JSZip();
    const total = mods.length;
    let done = 0;
    label.textContent = `Fetching… (0/${total})`;

    try {
      await Promise.all(
        mods.map(async (mod) => {
          const res = await fetch(`${mod.folder}/${encodeURIComponent(mod.filename)}`);
          if (res.ok) zip.file(mod.filename, await res.arrayBuffer());
          done++;
          label.textContent = `Fetching… (${done}/${total})`;
        })
      );

      label.textContent = "Zipping…";
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
