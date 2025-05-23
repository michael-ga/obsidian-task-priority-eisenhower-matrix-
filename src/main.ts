// This file is the main entry point for the Obsidian plugin. It typically contains the code to initialize the plugin, register commands, and set up event listeners.

import { App, Plugin, PluginSettingTab, Setting, TFile, Notice, Modal } from "obsidian";

// Eisenhower helpers (inlined from eisenhower.ts)
interface EisenhowerTask {
    content: string;
    importance: "high" | "low";
    urgency: "high" | "low";
    durationMinutes: number;
    file: string;
    line: number;
}
function parseTask(line: string, file: string, lineNumber: number): EisenhowerTask | null {
    const importance = /importance::\s*(high|low)/i.exec(line)?.[1]?.toLowerCase() as "high" | "low" | undefined;
    const urgency = /urgency::\s*(high|low)/i.exec(line)?.[1]?.toLowerCase() as "high" | "low" | undefined;
    const duration = /duration::\s*(\d+)/i.exec(line)?.[1];
    const isUrgent = /🔥/.test(line) || urgency === "high";
    const isImportant = /⭐/.test(line) || importance === "high";
    const durationMinutes = /⏳(\d+)/.exec(line)?.[1] || duration || "0";
    if (isUrgent === undefined && isImportant === undefined) return null;
    return {
        content: line,
        importance: isImportant ? "high" : "low",
        urgency: isUrgent ? "high" : "low",
        durationMinutes: parseInt(durationMinutes),
        file,
        line: lineNumber
    };
}
function groupTasks(tasks: EisenhowerTask[]) {
    return {
        "Urgent & Important": tasks.filter((t: EisenhowerTask) => t.importance === "high" && t.urgency === "high"),
        "Not Urgent but Important": tasks.filter((t: EisenhowerTask) => t.importance === "high" && t.urgency === "low"),
        "Urgent but Not Important": tasks.filter((t: EisenhowerTask) => t.importance === "low" && t.urgency === "high"),
        "Neither Urgent nor Important": tasks.filter((t: EisenhowerTask) => t.importance === "low" && t.urgency === "low"),
    };
}
function renderEisenhowerMatrix(groups: ReturnType<typeof groupTasks>): string {
    return `# Eisenhower Matrix\n\n` +
        `## Urgent & Important\n` +
        groups["Urgent & Important"].map((t: EisenhowerTask) => `- ${t.content}`).join("\n") +
        `\n\n## Not Urgent but Important\n` +
        groups["Not Urgent but Important"].map((t: EisenhowerTask) => `- ${t.content}`).join("\n") +
        `\n\n## Urgent but Not Important\n` +
        groups["Urgent but Not Important"].map((t: EisenhowerTask) => `- ${t.content}`).join("\n") +
        `\n\n## Neither Urgent nor Important\n` +
        groups["Neither Urgent nor Important"].map((t: EisenhowerTask) => `- ${t.content}`).join("\n");
}
function renderEisenhowerMatrixHTML(groups: ReturnType<typeof groupTasks>, settings: MyPluginSettings): string {
    // Helper to strip Eisenhower properties from task content
    function stripProps(content: string): string {
        return content
            .replace(/^\s*- \[ \]/, "")
            .replace(/\s*importance::\s*(high|low)/gi, "")
            .replace(/\s*urgency::\s*(high|low)/gi, "")
            .replace(/\s*duration::\s*\d+/gi, "")
            .replace(/\s*⭐/g, "")
            .replace(/\s*🔥/g, "")
            .replace(/\s*⏳\d*/g, "")
            .trim();
    }
    // Color codes for quadrants
    const quadrantColors = {
        "Urgent & Important": "#ffcccc", // red-ish
        "Not Urgent but Important": "#fff7cc", // yellow-ish
        "Urgent but Not Important": "#cce5ff", // blue-ish
        "Neither Urgent nor Important": "#e0e0e0" // gray
    };
    return `
    <style>
      .eisenhower-matrix-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        grid-template-rows: 1fr 1fr;
        gap: 16px;
        width: 100%;
        max-width: 700px;
        margin: 0 auto;
        font-family: inherit;
      }
      .eisenhower-matrix-cell {
        border: 2px solid #888;
        border-radius: 8px;
        padding: 12px 10px 10px 10px;
        min-height: 120px;
        box-sizing: border-box;
        color: #111;
      }
      .eisenhower-matrix-title {
        font-weight: bold;
        margin-bottom: 8px;
        font-size: 1.1em;
      }
      .eisenhower-matrix-task {
        margin-left: 0;
        margin-bottom: 4px;
        font-size: 1em;
        list-style: disc inside;
        cursor: pointer;
        text-decoration: underline dotted #888;
      }
    </style>
    <div class="eisenhower-matrix-grid">
      <div class="eisenhower-matrix-cell" style="background:${quadrantColors["Urgent & Important"]}">
        <div class="eisenhower-matrix-title">${settings.matrixUrgencyEmoji}${settings.matrixImportanceEmoji} Urgent & Important</div>
        <ul>
          ${groups["Urgent & Important"].map((t, idx) => `<li class='eisenhower-matrix-task' data-file='${encodeURIComponent(t.file)}' data-line='${t.line}'>${escapeHtml(stripProps(t.content))}</li>`).join("") || '<li class="eisenhower-matrix-task" style="color:#aaa">No tasks</li>'}
        </ul>
      </div>
      <div class="eisenhower-matrix-cell" style="background:${quadrantColors["Not Urgent but Important"]}">
        <div class="eisenhower-matrix-title">${settings.matrixImportanceEmoji} Not Urgent but Important</div>
        <ul>
          ${groups["Not Urgent but Important"].map((t, idx) => `<li class='eisenhower-matrix-task' data-file='${encodeURIComponent(t.file)}' data-line='${t.line}'>${escapeHtml(stripProps(t.content))}</li>`).join("") || '<li class="eisenhower-matrix-task" style="color:#aaa">No tasks</li>'}
        </ul>
      </div>
      <div class="eisenhower-matrix-cell" style="background:${quadrantColors["Urgent but Not Important"]}">
        <div class="eisenhower-matrix-title">${settings.matrixUrgencyEmoji} Urgent but Not Important</div>
        <ul>
          ${groups["Urgent but Not Important"].map((t, idx) => `<li class='eisenhower-matrix-task' data-file='${encodeURIComponent(t.file)}' data-line='${t.line}'>${escapeHtml(stripProps(t.content))}</li>`).join("") || '<li class="eisenhower-matrix-task" style="color:#aaa">No tasks</li>'}
        </ul>
      </div>
      <div class="eisenhower-matrix-cell" style="background:${quadrantColors["Neither Urgent nor Important"]}">
        <div class="eisenhower-matrix-title">Neither Urgent nor Important</div>
        <ul>
          ${groups["Neither Urgent nor Important"].map((t, idx) => `<li class='eisenhower-matrix-task' data-file='${encodeURIComponent(t.file)}' data-line='${t.line}'>${escapeHtml(stripProps(t.content))}</li>`).join("") || '<li class="eisenhower-matrix-task" style="color:#aaa">No tasks</li>'}
        </ul>
      </div>
    </div>
    <script>
      (function() {
        const tasks = document.querySelectorAll('.eisenhower-matrix-task[data-file][data-line]');
        tasks.forEach(el => {
          el.addEventListener('click', function(e) {
            const file = decodeURIComponent(this.getAttribute('data-file'));
            const line = parseInt(this.getAttribute('data-line'), 10);
            // @ts-ignore
            if (window.app && window.app.workspace) {
              // Open the file and scroll to the line
              window.app.workspace.openLinkText(file, '', false).then(() => {
                const leaf = window.app.workspace.getMostRecentLeaf();
                if (leaf && leaf.view && leaf.view.editor) {
                  leaf.view.editor.setCursor({ line: line - 1, ch: 0 });
                }
              });
            }
          });
        });
      })();
    </script>
    `;
}

function escapeHtml(str: string): string {
    return str.replace(/[&<>"']/g, function (tag) {
        const chars: Record<string, string> = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        };
        return chars[tag] || tag;
    });
}

class EisenhowerMatrixModal extends Modal {
    html: string;
    constructor(app: App, html: string) {
        super(app);
        this.html = html;
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "Eisenhower Matrix (Visual)" });
        const wrapper = contentEl.createDiv();
        wrapper.innerHTML = this.html;
    }
}

interface MyPluginSettings {
    headerText: string;
    promptTemplate: string;
    matrixImportanceEmoji: string;
    matrixUrgencyEmoji: string;
    matrixDurationEmoji: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
    headerText: "היום",
    promptTemplate: `סכם את הטקסט הבא , \nלמד מה היה טוב ועבד טוב , מה הזיק לאנרגיה והיה שלילי ומצא תובנות חשובות\n{days}`,
    matrixImportanceEmoji: "⭐",
    matrixUrgencyEmoji: "🔥",
    matrixDurationEmoji: "⏳"
};

export default class MyPlugin extends Plugin {
    settings!: MyPluginSettings; // definite assignment assertion

    async onload() {
        await this.loadSettings();
        this.addCommand({
            id: "summarise-week",
            name: "Summarise Week",
            callback: () => this.summariseWeek()
        });
        this.addCommand({
            id: "eisenhower-matrix",
            name: "Show Eisenhower Matrix",
            callback: () => this.showEisenhowerMatrix()
        });
        this.addCommand({
            id: "add-eisenhower-properties",
            name: "Add Eisenhower Properties to Task",
            editorCallback: async (editor, view) => {
                const cursor = editor.getCursor();
                const line = editor.getLine(cursor.line);
                if (!/^- \[.\]/.test(line)) {
                    new Notice("Cursor must be on a task line (starting with - [ ] or - [x])");
                    return;
                }
                // Show a modal prompt for importance, urgency, duration
                const importance = await this.selectOption("Select importance", ["high", "low"]);
                if (!importance) return;
                const urgency = await this.selectOption("Select urgency", ["high", "low"]);
                if (!urgency) return;
                const duration = await this.promptInput("Enter duration in minutes (optional)");
                // Append to task line if not already present
                let newLine = line;
                if (!/importance::/.test(line)) newLine += ` importance::${importance}`;
                if (!/urgency::/.test(line)) newLine += ` urgency::${urgency}`;
                if (duration && !/duration::/.test(line)) newLine += ` duration::${duration.trim()}`;
                editor.setLine(cursor.line, newLine);
                new Notice("Eisenhower properties added to task.");
            }
        });
        this.addSettingTab(new MyPluginSettingTab(this.app, this));
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }

    async selectOption(prompt: string, options: string[]): Promise<string | null> {
        return new Promise((resolve) => {
            class OptionModal extends Modal {
                result: string | null = null;
                constructor(app: App) { super(app); }
                onOpen() {
                    const { contentEl } = this;
                    contentEl.createEl("h2", { text: prompt });
                    options.forEach(opt => {
                        const btn = contentEl.createEl("button", { text: opt });
                        btn.onclick = () => { this.result = opt; this.close(); };
                    });
                }
                onClose() { resolve(this.result); }
            }
            new OptionModal(this.app).open();
        });
    }

    async promptInput(prompt: string): Promise<string | null> {
        return new Promise((resolve) => {
            class InputModal extends Modal {
                value: string = "";
                constructor(app: App) { super(app); }
                onOpen() {
                    const { contentEl } = this;
                    contentEl.createEl("h2", { text: prompt });
                    const input = contentEl.createEl("input");
                    input.type = "text";
                    input.oninput = (e: any) => { this.value = e.target.value; };
                    input.onkeydown = (e: KeyboardEvent) => { if (e.key === "Enter") { this.close(); } };
                    input.focus();
                }
                onClose() { resolve(this.value); }
            }
            new InputModal(this.app).open();
        });
    }

    async summariseWeek() {
        const files = this.app.vault.getMarkdownFiles();
        // Get current time and 7 days ago
        const now = Date.now();
        const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
        // Filter files modified in the last 7 days
        const recentFiles = files
            .filter(f => f.stat.mtime >= sevenDaysAgo)
            .sort((a, b) => b.stat.mtime - a.stat.mtime)
            .slice(0, 7)
            .reverse(); // oldest first
        let daysText: string[] = [];
        for (const file of recentFiles) {
            const content = await this.app.vault.read(file);
            // Extract sections under ## headers containing the headerText (robust for RTL/Hebrew and emoji)
            const regex = new RegExp(`^##\s*.*?${this.settings.headerText}.*?\r?\n([\s\S]*?)(?=^##|\Z)`, "gm");
            let match;
            while ((match = regex.exec(content)) !== null) {
                daysText.push(match[1].trim());
            }
        }
        const prompt = this.settings.promptTemplate.replace("{days}", daysText.join("\n"));
        await navigator.clipboard.writeText(prompt);
        new Notice("Week summary prompt copied to clipboard!");
    }

    async showEisenhowerMatrix() {
        const files = this.app.vault.getMarkdownFiles();
        let tasks: EisenhowerTask[] = [];
        for (const file of files) {
            const content = await this.app.vault.read(file);
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                // Only include not-done tasks
                if (/^- \[ \]/.test(line)) {
                    // Accept tasks with at least one Eisenhower property (importance or urgency, via property or emoji)
                    const hasImportance = /importance::\s*(high|low)/.test(line) || /⭐/.test(line);
                    const hasUrgency = /urgency::\s*(high|low)/.test(line) || /🔥/.test(line);
                    // Accept if either property is present (not both required)
                    if (hasImportance || hasUrgency) {
                        const task = parseTask(line, file.path, i + 1);
                        if (task) {
                            tasks.push(task);
                        }
                    } else if (/importance::\s*low/.test(line) && /urgency::\s*low/.test(line)) {
                        // Fallback: create a minimal EisenhowerTask for 'Neither Urgent nor Important'
                        tasks.push({
                            content: line,
                            importance: "low",
                            urgency: "low",
                            durationMinutes: 0,
                            file: file.path,
                            line: i + 1
                        });
                    }
                }
            }
        }
        const groups = groupTasks(tasks);
        const matrixMarkdown = renderEisenhowerMatrix(groups);
        // Create or find the matrix file
        let matrixFile = files.find(f => f.basename === "Eisenhower Matrix" && f.extension === "md");
        if (!matrixFile) {
            // Create new file
            matrixFile = await this.app.vault.create("Eisenhower Matrix.md", "");
        }
        // Write matrix to file
        await this.app.vault.modify(matrixFile, matrixMarkdown);
        // Open the matrix file
        this.app.workspace.openLinkText(matrixFile.basename, "", false);
        // Show visual modal
        const html = renderEisenhowerMatrixHTML(groups, this.settings);
        new EisenhowerMatrixModal(this.app, html).open();
    }
}

// Only one settings tab class
class MyPluginSettingTab extends PluginSettingTab {
    plugin: MyPlugin;
    constructor(app: App, plugin: MyPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl("h2", { text: "My Plugin Settings" });
        new Setting(containerEl)
            .setName("Header Text")
            .setDesc("Header text to extract for weekly summary (e.g. היום)")
            .addText(text => text
                .setPlaceholder("היום")
                .setValue(this.plugin.settings.headerText)
                .onChange(async (value) => {
                    this.plugin.settings.headerText = value;
                    await this.plugin.saveSettings();
                }));
        new Setting(containerEl)
            .setName("Prompt Template")
            .setDesc("Prompt template for week summary. Use {days} as placeholder.")
            .addTextArea(text => text
                .setPlaceholder("...{days}")
                .setValue(this.plugin.settings.promptTemplate)
                .onChange(async (value) => {
                    this.plugin.settings.promptTemplate = value;
                    await this.plugin.saveSettings();
                }));
        // --- Matrix Settings Section ---
        containerEl.createEl("h2", { text: "Eisenhower Matrix Settings" });
        new Setting(containerEl)
            .setName("Importance Emoji")
            .setDesc("Emoji to use for important tasks (default: ⭐)")
            .addText(text => text
                .setPlaceholder("⭐")
                .setValue(this.plugin.settings.matrixImportanceEmoji || "⭐")
                .onChange(async (value) => {
                    this.plugin.settings.matrixImportanceEmoji = value || "⭐";
                    await this.plugin.saveSettings();
                }));
        new Setting(containerEl)
            .setName("Urgency Emoji")
            .setDesc("Emoji to use for urgent tasks (default: 🔥)")
            .addText(text => text
                .setPlaceholder("🔥")
                .setValue(this.plugin.settings.matrixUrgencyEmoji || "🔥")
                .onChange(async (value) => {
                    this.plugin.settings.matrixUrgencyEmoji = value || "🔥";
                    await this.plugin.saveSettings();
                }));
        new Setting(containerEl)
            .setName("Duration Emoji")
            .setDesc("Emoji to use for duration (default: ⏳)")
            .addText(text => text
                .setPlaceholder("⏳")
                .setValue(this.plugin.settings.matrixDurationEmoji || "⏳")
                .onChange(async (value) => {
                    this.plugin.settings.matrixDurationEmoji = value || "⏳";
                    await this.plugin.saveSettings();
                }));
    }
}
