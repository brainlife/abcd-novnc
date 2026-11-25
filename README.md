<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/brand/brainlife-mark-on-dark.svg">
    <img src=".github/brand/brainlife-mark-on-light.svg" alt="brainlife.io" width="140">
  </picture>
</p>

<h1 align="center">abcd-novnc</h1>

<p align="center">
  Open brainlife.io datasets in desktop and web viewers, streamed to the browser.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Status-active-brightgreen.svg" alt="Status: active">
  <a href="https://brainlife.io"><img src="https://img.shields.io/badge/brainlife.io-site-3b9fd0.svg" alt="brainlife.io"></a>
  <a href="https://brainlife.io/docs"><img src="https://img.shields.io/badge/Docs-brainlife.io%2Fdocs-005981.svg" alt="Documentation"></a>
  <a href="https://doi.org/10.1038/s41592-024-02237-2"><img src="https://img.shields.io/badge/DOI-10.1038%2Fs41592--024--02237--2-e57536.svg" alt="Nature Methods paper"></a>
</p>

## 🧠 At a glance

| | |
|---|---|
| 🧭 **What** | An [ABCD-spec](https://github.com/brainlife/abcd-spec) App (`start.sh` / `status.sh` / `stop.sh`) that amaretti runs on a visualization host: it pulls the viewer container, mounts the dataset, creates a one-time password, starts noVNC (or nginx for web viewers) and writes the URL for the user |
| 🖥️ **Viewers** | Any `ui-*` container (FreeView, FSLeyes, mrview, DSI Studio, …) plus built-in web pages for mrview (`mrview-web.js`, combo views for DWI, CSD, tensor and T1) and ITK-SNAP |
| 🧱 **Needs** | Docker engine · noVNC in `/usr/local/noVNC` · Node.js · NVIDIA libraries for GPU viewers |
| 🕰️ **Last change** | 2026-10-28 |

## 🚀 How it runs

```bash
./start.sh     # copies GPU libraries, runs setup.js in the background (pull, password, port 11000–12000, container)
./status.sh    # reports running / finished / failed; url.txt holds the viewer URL
./stop.sh      # stops the container and the noVNC proxy
```

`setup.js` reads the task's `config.json` (input instance and task, optional subdir, container) and finds the dataset on the host. For local development, `BRAINLIFE_HOSTSCRATCH` points at the host scratch folder and Docker on the host is reached via `host.docker.internal`.

## 🧪 Tests

```bash
node --test *.test.js      # viewer lifecycle, mrview combo, gestures and review options
```

## 🔗 Related

[ui-niivue](https://github.com/brainlife/ui-niivue) · [ui-mrview](https://github.com/brainlife/ui-mrview) · [ui-freeview](https://github.com/brainlife/ui-freeview) · [amaretti-next](https://github.com/brainlife/amaretti-next)

## 📚 Citing

If you use brainlife.io in your work, please cite:

> Hayashi S, Caron BA, Heinsfeld AS, et al. brainlife.io: a decentralized and open-source cloud platform to support neuroscience research. *Nature Methods* 21:809–813 (2024). [doi:10.1038/s41592-024-02237-2](https://doi.org/10.1038/s41592-024-02237-2)

## 🤝 Contributing

Issues and pull requests are welcome in this repository. For help using brainlife.io, see the [documentation](https://brainlife.io/docs).

## ⚖️ License

This repository does not include a license file yet.

<p align="center"><sub>brainlife.io · Brain data across scales. One place to analyze, share and publish it. · The University of Texas at Austin</sub></p>
