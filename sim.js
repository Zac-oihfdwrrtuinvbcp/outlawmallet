// @ts-check
import child_process from "child_process";
import fs from "fs";

const THREADS = 32;
/**
 * @param {string} args 
 * @param {string} targetFile
 * @returns {object}
 */
function execBloodmalletWorker(args, targetFile) {
    const command = `docker run --mount type=bind,source="${process.cwd()}/results",target=/app/bloodytools/results -t ${args.indexOf("custom_profile") !== -1 ? "bloodytools_custom" : "bloodytools"} ${args} --threads=${THREADS}`;
    child_process.execSync(command, { stdio: "inherit" });
    const log = fs.readFileSync(`./results/${targetFile}`, { encoding: "utf-8" });
    return JSON.parse(log);
}

/**
 * @param {{profile?: string, single_sim: string, ptr?: boolean}} param0
 * @returns {object}
 */
function execBloodmallet({profile, single_sim, ptr}) {
    if (profile) {
        // Unfortunately, bloodmallet reads custom profiles from a file in the current working directory - this isn't bad normally, but is somewhat painful inside a not-yet-run container
        // It basically means we have to rebuild the container :(
        const dockerfile =
        `FROM bloodytools
        RUN rm ./custom_profile.txt
        RUN echo $'${profile.split("\n").join("\\n\\\n")}' >> ./custom_profile.txt
        ENTRYPOINT ["python3", "-m", "bloodytools", "--executable", "../SimulationCraft/engine/simc"]
        CMD ["--help"]\0`
        
        child_process.execSync(`docker build -t bloodytools_custom -`, { input: dockerfile, stdio: ["pipe", "inherit", "inherit"] });
        
    }
    return execBloodmalletWorker(`${ptr ? "-ptr " : ""}${profile ? "--custom_profile " : ""}--single_sim="${single_sim}"`, `${single_sim.split(",")[0]}/${single_sim.split(",").slice(1).join("_")}.json`);
}

function getBloodytoolsHash() {
    const dockerfile =
    `FROM bloodytools
    ENTRYPOINT ["git"]
    CMD ["log", "-1", "--format=format:%H", "--no-color"]\0`
    child_process.execSync(`docker build -t bloodytools_hash -`, { input: dockerfile, stdio: ["pipe", "inherit", "inherit"] });
    const output = child_process.execSync(`docker run bloodytools_hash`, { encoding: "utf-8" });
    return output.trim();
}

function getSimcHash() {
    const dockerfile =
    `FROM bloodytools
    ENTRYPOINT ["cat"]
    CMD ["../SimulationCraft/.git/refs/heads/dragonflight"]\0`
    child_process.execSync(`docker build -t bloodytools_simc_hash -`, { input: dockerfile, stdio: ["pipe", "inherit", "inherit"] });
    const output = child_process.execSync(`docker run bloodytools_simc_hash`, { encoding: "utf-8" });
    return (output || "").trim();
}

/**
 * @param {string} style 
 * @param {string} talentString 
 */
function getMaxDps(style, talentString) {
    const data = JSON.parse(fs.readFileSync(`./docs/${style}/talents/${talentString}/secondary_distributions.json`, { encoding: "utf-8" }));
    return data.data.baseline[data.sorted_data_keys.baseline[0]];
}

const talentFileContents = fs.readFileSync("./outlaw-talent-builds.simc", { encoding: "utf-8" });
const presentTalents = {};
const talents = talentFileContents.split("\n\n").map(s => {
    const [namePart, talentPart] = s.split("\n");
    const name = namePart.slice(`copy="`.length, namePart.length - 1);
    const rawTalentStr = talentPart.slice(`talents=`.length);
    const buf = Buffer.from(rawTalentStr, "base64");
    for (let i = 3; i < 19; i++) { buf[i] = 0 } // zero out hash part of talent string, emulates wowhead export and ensures there's only one talent string for a given build
    const talentStr = buf.toString("base64").replaceAll("=", "");
    if (talentStr !== rawTalentStr && talentStr+"A" !== rawTalentStr && talentStr+"AA" !== rawTalentStr) { // b64 encoder will drop trailing zero values by default - just tack on a few to cover them being dropped
        throw new Error(`Build ${name}:
    Expected unhashed talent string: ${talentStr},
        got talent string with hash: ${rawTalentStr}.`);
    }
    if (presentTalents[rawTalentStr]) {
        throw new Error(`Build ${name}:
    Duplicate talent string: ${rawTalentStr}
    Also is build ${presentTalents[rawTalentStr]}`);
    }
    presentTalents[rawTalentStr] = name;
    return [name, rawTalentStr];
});
const baseProfile = fs.readFileSync("./profile_gear.simc", { encoding: "utf-8" });
const simcHash = getSimcHash();
const toolsHash = getBloodytoolsHash();

console.log(`Simc hash: ${simcHash}
tools hash: ${toolsHash}`);

const fightStyles = [
    "castingpatchwerk",
    "castingpatchwerk8",
    "castingpatchwerk5",
    "castingpatchwerk3",
    // "dungeonslice", // Dungeonslice secondary distribution sims take over an hour per sim, compared with 5-10 minutes for the patchwerks. Ain't nobody got time for that.
];

/**
 * @param {string} style 
 */
function collectDataForFightStyle(style) {
    for (const [name, talent] of talents) {
        const dataPath = `./docs/${style}/talents/${talent}/secondary_distributions.json`;
        let result;
        try {
            const maybeResult = JSON.parse(fs.readFileSync(dataPath, { encoding: "utf-8" }));
            if (maybeResult?.metadata?.SimulationCraft === simcHash && maybeResult?.metadata?.bloodytools === toolsHash) {
                result = maybeResult;
                console.log(`Results for ${name} already generated, skipping...`);
            }
        }
        catch (_) {}
        if (!result) {
            console.log(`Simulating secondary distributions for ${name}...`);
            result = execBloodmallet({single_sim: `secondary_distributions,rogue,outlaw,${style}`, ptr: true, profile:
    `rogue="${name}"
spec=outlaw
level=70
race=tauren
role=attack
position=back
${baseProfile}
talents=${talent}`});
            result.title = result.title.replace("Outlaw Rogue", `Outlaw Rogue - ${name}`);
            fs.mkdirSync(`./docs/${style}/talents/${talent}`, { recursive: true });
            fs.writeFileSync(dataPath, JSON.stringify(result, null, 4));
        }
        // always regenerate the html, so any updates made to the chart style are applied immediately on run
        fs.writeFileSync(`./docs/${style}/talents/${talent}/index.html`,
    `
<html>
    <head>
        <script src="https://code.highcharts.com/highcharts.js"></script>
        <script src="https://code.highcharts.com/highcharts-3d.js"></script>
        <script src="https://bloodmallet.com/js/bloodmallet_chart_import.min.js"></script>
        <title>Outlawmallet - Secondary Distribution - ${style} - ${talent}</title>
        <link rel="icon" type="image/x-icon" href="/favicon.ico">
        <style>
            body {
                background-color: #343a40;
            }
            iframe {
                border: none;
            }
        </style>
    </head>
    <body>
        <div style="display: grid; width: 100%; gap: 10px; justify-items: center;">
        <div
        id="unique-id" 
        class="bloodmallet_chart" 
        data-wow-class="rogue" 
        data-wow-spec="outlaw" 
        data-type="secondary_distributions"
        data-fight-style="castingpatchwerk"
        data-chart-engine="highcharts"
        data-tooltip-engine="wowhead"
        data-background-color="#343a40" 
        data-font-color="#f8f9fa" 
        data-axis-color="#828282"
        data-language="en"
        data-loaded-data=""
        >Loading...</div>
        <div style="color: #f8f9fa;">
        <iframe src="https://mimiron.raidbots.com/simbot/render/talents/${talent}?bgcolor=343a40&amp;level=70&amp;width=800" width="800" height="570"></iframe>
        </div>
        </div>
        <script>
        document.getElementById("unique-id").dataset.loadedData = \`${JSON.stringify(result).replaceAll(`\\`, `\\\\`)}\`
        </script>
    </body>
</html>
    `);
    }
}

/**
 * @param {string} style 
 */
function updateIndex(style) {
    const rankedData = talents.map(([name, talentString]) => [name, fs.existsSync(`./docs/${style}/talents/${talentString}/secondary_distributions.json`) ? getMaxDps(style, talentString) : undefined, talentString]).filter(t => !!t[1]);
    rankedData.sort((a, b) => b[1] - a[1]);

// This chart layout is roughly extracted from https://bloodmallet.com/js/bloodmallet_chart_import.min.js, just so it visually matches the style of the bloodmallet charts
// There's maybe enough copied here to warrant some kind of license disclaimer, but said js file doesn't have one, and neither does its' source repo, so... 🤷‍♂️
// Just know it's mostly sourced form there, and you should thank bloodmallet.com for the styles.
    fs.writeFileSync(`./docs/${style}/index.html`, `
    <html>
        <head>
            <script src="https://code.highcharts.com/highcharts.js"></script>
            <script src="https://code.highcharts.com/modules/exporting.js"></script>
            <title>Outlawmallet - ${style} - Talents</title>
            <link rel="icon" type="image/x-icon" href="/favicon.ico">
            <style>
                body {
                    background-color: #343a40;
                    height: 100%;
                    min-height: ${talents.length * 2.5}em;
                    margin: 0px;
                }

                .build-link {
                    color: #f8f9fa;
                    text-decoration: none;
                }

                .build-link:hover {
                    color: magenta;
                    text-decoration: underline;
                }
            </style>
        </head>
        <body>
            <div id="unique-id" style="height: 100%">Loading...</div>
        <script>

            const rankedData = ${JSON.stringify(rankedData)};
            const absolute_damage_per_second = "Damage per second";
            const bar_colors = ["#e4d354"];
            const default_background_color = "#343a40";
            const default_font_color = "#f8f9fa";
            const default_axis_color = "#828282";
            const font_size = "1.1rem";
            const background_color = "#343a40";
            const axis_color = "#828282";
            const font_color = "#f8f9fa";
            const makeRelative = function() {
                this.yAxis[0].setTitle({text: "Δ% From Best DPS"});
                this.yAxis[1].setTitle({text: "Δ% From Best DPS"});
                this.series[0].setName("Δ% DPS");
                this.series[0].setData(
                    rankedData.map(t => Math.floor((1 - t[1]/rankedData[0][1]) * -10000)/100)
                );
                this.yAxis[0].setExtremes((1 - rankedData[rankedData.length - 1][1]/rankedData[0][1]) * -100, 0);
                this.exporting.update({
                    buttons: {
                        contextButton: { enabled: false },
                        toggleButton: { text: "Absolute", onclick: makeAbsolute }
                    }
                });
            }
            const makeAbsolute = function() {
                this.yAxis[0].setTitle({text: absolute_damage_per_second});
                this.yAxis[1].setTitle({text: absolute_damage_per_second});
                this.series[0].setName("DPS");
                this.series[0].setData(
                    rankedData.map(t => t[1])
                );
                this.yAxis[0].setExtremes(0, rankedData[0][1]);
                this.exporting.update({
                    buttons: {
                        contextButton: { enabled: false },
                        toggleButton: { text: "Relative", onclick: makeRelative }
                    }
                });
            }
            const styled_chart = {
                navigation: {
                    buttonOptions: {
                        theme: {
                            fill: default_axis_color
                        }
                    }
                },
                exporting: {
                    buttons: {
                        contextButton: {
                            enabled: false
                        },
                        toggleButton: {
                            text: "Relative",
                            onclick: makeRelative
                        },
                    }
                },
                plotOptions: {
                    series: {
                        dataLabels: {
                            align: "right",
                            enabled: true
                        }
                    }
                },
                credits: {
                    enabled: true,
                    href: "https://github.com/weswigham/outlawmallet",
                    text: "Check out the source on GitHub"
                },
                accessibility: {
                    enabled: false
                },
                chart: {
                    type: "bar",
                    backgroundColor: background_color,
                    style: {
                        fontFamily: "-apple-system,BlinkMacSystemFont,\\"Segoe UI\\",Roboto,\\"Helvetica Neue\\",Arial,sans-serif,\\"Apple Color Emoji\\",\\"Segoe UI Emoji\\",\\"Segoe UI Symbol\\""
                    }
                },
                colors: bar_colors,
                legend: {
                    align: "right",
                    backgroundColor: background_color,
                    borderColor: axis_color,
                    borderWidth: 1,
                    floating: false,
                    itemMarginBottom: 3,
                    itemMarginTop: 0,
                    layout: 'vertical',
                    reversed: true,
                    shadow: false,
                    verticalAlign: "middle",
                    x: 0,
                    y: 0,
                    itemStyle: {
                        color: font_color,
                    },
                    itemHoverStyle: {
                        color: font_color,
                    },
                    title: {
                        text: " ",
                        style: {
                            color: default_font_color
                        }
                    },
                    symbolRadius: 0
                },
                series: [{
                    name: "DPS",
                    data: rankedData.map(t => t[1])
                }],
                title: {
                    text: '${style} Outlaw Rogue Talent DPS With Optimal Secondary Stats (simc <a href="https://github.com/simulationcraft/simc/commit/${simcHash}">${simcHash.slice(0,8)}</a>)',
                    useHTML: true,
                    style: {
                        color: font_color,
                        fontSize: font_size
                    }
                },
                tooltip: {
                    headerFormat: "<b>{point.x}</b>",
                    shared: true,
                    backgroundColor: default_background_color,
                    borderColor: default_axis_color,
                    style: {
                        color: default_font_color,
                        fontSize: font_size,
                    },
                    useHTML: true,
                },
                xAxis: {
                    categories: rankedData.map(t => \`<a class="build-link" target="_blank" href="./talents/$\{t[2]\}/index.html">$\{t[0]\}</a>\`),
                    labels: {
                        useHTML: true,
                        style: {
                            color: default_font_color,
                            fontSize: font_size,
                        }
                    },
                    gridLineWidth: 0,
                    gridLineColor: default_axis_color,
                    lineColor: default_axis_color,
                    tickColor: default_axis_color
                },
                yAxis: [{
                    labels: {
                        style: {
                            color: default_axis_color
                        },
                    },
                    min: 0,
                    stackLabels: {
                        enabled: true,
                        formatter: function() {
                            return Intl.NumberFormat().format(this.total);
                        },
                        style: {
                            color: default_font_color,
                            textOutline: false,
                            fontSize: font_size,
                            fontWeight: "normal"
                        }
                    },
                    title: {
                        text: absolute_damage_per_second,
                        style: {
                            color: default_axis_color
                        }
                    },
                    gridLineWidth: 1,
                    gridLineColor: default_axis_color
                }, {
                    linkedTo: 0,
                    opposite: true,
                    labels: {
                        style: {
                            color: default_axis_color
                        },
                    },
                    min: 0,
                    stackLabels: {
                        enabled: true,
                        formatter: function() {
                            return Intl.NumberFormat().format(this.total);
                        },
                        style: {
                            color: default_font_color,
                            textOutline: false,
                            fontSize: font_size,
                            fontWeight: "normal"
                        }
                    },
                    title: {
                        text: absolute_damage_per_second,
                        style: {
                            color: default_axis_color
                        }
                    },
                    gridLineWidth: 1,
                    gridLineColor: default_axis_color
                }]
            };
            styled_chart.tooltip.backgroundColor = background_color;
            styled_chart.tooltip.borderColor = axis_color;
            styled_chart.tooltip.style.color = font_color;
            styled_chart.xAxis.labels.style.color = font_color;
            styled_chart.xAxis.gridLineColor = axis_color;
            styled_chart.xAxis.lineColor = axis_color;
            styled_chart.xAxis.tickColor = axis_color;
            styled_chart.yAxis[0].labels.style.color = axis_color;
            styled_chart.yAxis[0].stackLabels.style.color = font_color;
            styled_chart.yAxis[0].gridLineColor = axis_color;
            styled_chart.yAxis[0].lineColor = axis_color;
            styled_chart.yAxis[0].tickColor = axis_color;
            styled_chart.yAxis[0].title.style.color = axis_color;
            styled_chart.yAxis[1].labels.style.color = axis_color;
            styled_chart.yAxis[1].stackLabels.style.color = font_color;
            styled_chart.yAxis[1].gridLineColor = axis_color;
            styled_chart.yAxis[1].lineColor = axis_color;
            styled_chart.yAxis[1].tickColor = axis_color;
            styled_chart.yAxis[1].title.style.color = axis_color;
            Highcharts.chart("unique-id", styled_chart);
        </script>
        </body>
    </html>
    `);
}

for (const style of fightStyles) {
    collectDataForFightStyle(style);
    updateIndex(style);
}

fs.writeFileSync("./docs/index.html", `
<html>
    <head>
        <title>Outlawmallet</title>
        <link rel="icon" type="image/x-icon" href="./favicon.ico">
        <style>
            iframe {
                height: 100%;
                width: 100%;
                padding: 0;
                margin: 0;
                border: none;
                min-height: ${talents.length * 2.5}em;
            }
            body {
                margin: 0;
            }
        </style>
    </head>
    <body>
        <iframe src="./castingpatchwerk/index.html"></iframe>
        <iframe src="./castingpatchwerk3/index.html"></iframe>
        <iframe src="./castingpatchwerk5/index.html"></iframe>
        <iframe src="./castingpatchwerk8/index.html"></iframe>
    </body>
</html>`);