// HTML report generator for E2E test screenshots
const fs = require('fs');
const path = require('path');

function generateReport(reportEntries, screenshotDir) {
    // Group entries: consecutive entries with same group become carousels
    const sections = [];
    let currentGroup = null;
    let currentItems = [];

    for (const entry of reportEntries) {
        if (entry.group !== currentGroup) {
            if (currentItems.length > 0) sections.push({ group: currentGroup, items: currentItems });
            currentGroup = entry.group;
            currentItems = [entry];
        } else {
            currentItems.push(entry);
        }
    }
    if (currentItems.length > 0) sections.push({ group: currentGroup, items: currentItems });

    const totalSections = sections.length;
    const sectionsHtml = sections.map((section, sIdx) => {
        const first = section.items[0];
        const isPhoneGroup = section.items.length > 1 && section.items.every(i => i.device === 'phone');
        const phase = first.phase || section.group;
        const narrator = section.items.find(i => i.narrator)?.narrator || '';

        let content;
        if (isPhoneGroup) {
            const items = section.items.map(item =>
                '<div class="carousel-item">' +
                '<img src="' + item.filename + '" alt="' + item.label + '" loading="lazy">' +
                '<div class="player-label">\u{1F4F1} ' + item.playerName + '\'s screen</div>' +
                '</div>'
            ).join('\n');
            content = '<div class="carousel"><div class="carousel-track">' + items + '</div></div>';
        } else {
            content = section.items.map(item => {
                const cls = 'single-shot ' + item.device;
                let label = '';
                if (item.device === 'phone') {
                    label = '<div class="player-label">\u{1F4F1} ' + item.playerName + '\'s screen</div>';
                }
                return '<div class="' + cls + '">' +
                    '<img src="' + item.filename + '" alt="' + item.label + '" loading="lazy">' +
                    label + '</div>';
            }).join('\n');
        }

        const stepLabel = '<span class="step-badge">Step ' + (sIdx + 1) + '/' + totalSections + '</span>';
        const phaseBadge = phase ? '<span class="phase-badge">' + phase + '</span>' : '';
        const deviceBadge = '<span class="device-badge ' + first.device + '">' +
            (first.device === 'tv' ? '\u{1F5A5}\u{FE0F} TV' : '\u{1F4F1} Phones') + '</span>';
        const narratorSpan = narrator ? '<span class="narrator-text">' + narrator + '</span>' : '';

        return '<div class="section" id="step-' + (sIdx + 1) + '">' +
            '<div class="section-header">' + stepLabel + phaseBadge + deviceBadge + narratorSpan + '</div>' +
            content + '</div>';
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Suspects \u2014 E2E Test Report</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0a0a0f; color: #e0e0e0; font-family: 'Inter', system-ui, sans-serif; padding: 2rem; }
h1 { text-align: center; font-size: 2.5rem; color: #e74c3c; letter-spacing: 0.2em; margin-bottom: 0.5rem; }
.subtitle { text-align: center; color: #888; margin-bottom: 2rem; }
.section { margin-bottom: 1.5rem; border-bottom: 1px solid #222; padding-bottom: 1.5rem; position: relative; }
.section-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
.phase-badge { background: #e74c3c; color: white; padding: 0.3rem 1rem; border-radius: 20px; font-size: 0.85rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; }
.step-badge { background: #333; color: #fff; padding: 0.3rem 0.8rem; border-radius: 20px; font-size: 0.8rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.narrator-text { color: #f1c40f; font-style: italic; font-size: 1.1rem; }
.narrator-text::before { content: '\u{1F399}\u{FE0F} '; }
.device-badge { font-size: 0.75rem; padding: 0.2rem 0.6rem; border-radius: 10px; background: #222; color: #888; }
.device-badge.tv { background: #1a237e; color: #90caf9; }
.device-badge.phone { background: #1b5e20; color: #a5d6a7; }
.single-shot { text-align: center; }
.single-shot img { max-width: 100%; border-radius: 12px; border: 2px solid #222; }
.single-shot.tv img { max-width: 900px; }
.single-shot.phone img { max-width: 300px; }
.carousel { position: relative; overflow: hidden; }
.carousel-track { display: flex; gap: 0.75rem; overflow-x: auto; scroll-snap-type: x mandatory; padding: 0.5rem 0;
    scrollbar-width: thin; scrollbar-color: #e74c3c #1a1a2e; }
.carousel-track::-webkit-scrollbar { height: 8px; }
.carousel-track::-webkit-scrollbar-track { background: #1a1a2e; border-radius: 4px; }
.carousel-track::-webkit-scrollbar-thumb { background: #e74c3c; border-radius: 4px; }
.carousel-item { flex: 0 0 auto; scroll-snap-align: start; text-align: center; }
.carousel-item img { width: 195px; height: 422px; object-fit: cover; object-position: top; border-radius: 12px; border: 2px solid #333; transition: border-color 0.2s; }
.carousel-item img:hover { border-color: #e74c3c; }
.carousel-item .player-label { margin-top: 0.5rem; color: #aaa; font-size: 0.9rem; font-weight: 600; }
.player-label { margin-top: 0.5rem; color: #aaa; font-size: 0.9rem; font-weight: 600; text-align: center; }
.timeline { position: relative; padding-left: 2rem; }
.timeline::before { content: ''; position: absolute; left: 0.5rem; top: 0; bottom: 0; width: 2px;
    background: linear-gradient(180deg, #e74c3c, #f1c40f, #2ecc71, #e74c3c); }
.section::before { content: ''; position: absolute; left: -1.5rem; width: 14px; height: 14px; border-radius: 50%;
    background: #e74c3c; border: 2px solid #0a0a0f; margin-top: 0.3rem; }
</style>
</head>
<body>
<h1>\u{1F3AD} SUSPECTS</h1>
<p class="subtitle">E2E Test Report \u2014 ${new Date().toLocaleString()}</p>
<div class="timeline">
${sectionsHtml}
</div>
</body>
</html>`;

    fs.writeFileSync(path.join(screenshotDir, 'report.html'), html);
    console.log('\u{1F4C4} Report saved to ./tmp/report.html');
}

module.exports = { generateReport };
