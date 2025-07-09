// This file is the main entry point for the Obsidian plugin. It typically contains the code to initialize the plugin, register commands, and set up event listeners.

import { App, Plugin, PluginSettingTab, Setting, TFile, Notice, Modal } from "obsidian";
import { WorkspaceLeaf, ItemView, MarkdownView } from "obsidian";

// Eisenhower helpers (inlined from eisenhower.ts)
interface EisenhowerTask {
    content: string;
    importance: "high" | "low";
    urgency: "high" | "low";
    durationMinutes: number;
    file: string;
    line: number;
    habitType?: "daily" | "weekly" | null; // new field for habit detection
    accumulated?: boolean; // accumulated task support
    accumulatedCount?: number; // count for accumulated tasks
    lastDoneDate?: string; // for daily/weekly habits
    taskType?: "repeated-daily" | "scheduled" | "regular"; // new field for task classification
    scheduledDate?: string; // for ⏳ YYYY-MM-DD tasks
    startDate?: string; // for ➕ YYYY-MM-DD tasks
    // Streak properties for Option A
    currentStreak?: number; // current consecutive streak
    maxStreak?: number; // personal best streak
    lastStreakDate?: string; // last date streak was updated
    attributeName?: string; // for [attribute::...] habits
}
function parseTask(line: string, file: string, lineNumber: number): EisenhowerTask | null {
    // Fix bracket property detection
    const importance = /\[importance::\s*(high|low)\]/i.exec(line)?.[1]?.toLowerCase() as "high" | "low" | undefined;
    const urgency = /\[urgency::\s*(high|low)\]/i.exec(line)?.[1]?.toLowerCase() as "high" | "low" | undefined;
    const duration = /\[duration::\s*(\d+)\]/i.exec(line)?.[1];
    const isUrgent = /🔥/.test(line) || urgency === "high";
    const isImportant = /⭐/.test(line) || importance === "high";
    const durationMinutes = /⏳(\d+)/.exec(line)?.[1] || duration || "0";
    
    // Fix habit detection with proper brackets
    const habitMatch = /\[habit::\s*(daily|weekly)\]/i.exec(line);
    const hasHabitEmoji = /🔁/.test(line); // Updated to use 🔁 instead of 🔄
    let habitType: "daily" | "weekly" | null = null;
    if (habitMatch) habitType = habitMatch[1].toLowerCase() as "daily" | "weekly";
    else if (hasHabitEmoji) habitType = "daily";
    
    // Accumulated task detection with proper brackets
    const accumulated = /\[accumulated::\s*true\]/i.test(line) || /🪙/.test(line);
    
    // Count detection: [success::N] or [N] at end of line (now supports negative values)
    let accumulatedCount: number | undefined = undefined;
    const successMatch = /\[success::(-?\d+)]/i.exec(line);
    if (successMatch) {
        accumulatedCount = parseInt(successMatch[1]);
    } else {
        const bracketCount = /\[(-?\d+)]\s*$/g.exec(line);
        if (bracketCount) accumulatedCount = parseInt(bracketCount[1]);
    }
    
    // Parse last-done property for daily/weekly habits with proper brackets
    let lastDoneDate: string | undefined = undefined;
    const lastDoneMatch = /\[last-done::(\d{4}-\d{2}-\d{2})\]/i.exec(line);
    if (lastDoneMatch) lastDoneDate = lastDoneMatch[1];
    
    // Parse streak properties for Option A implementation
    let currentStreak: number | undefined = undefined;
    let maxStreak: number | undefined = undefined;
    let lastStreakDate: string | undefined = undefined;
    
    const streakMatch = /\[streak::(\d+)\]/i.exec(line);
    if (streakMatch) currentStreak = parseInt(streakMatch[1]);
    
    const maxStreakMatch = /\[max-streak::(\d+)\]/i.exec(line);
    if (maxStreakMatch) maxStreak = parseInt(maxStreakMatch[1]);
    
    const lastStreakDateMatch = /\[last-streak-date::(\d{4}-\d{2}-\d{2})\]/i.exec(line);
    if (lastStreakDateMatch) lastStreakDate = lastStreakDateMatch[1];
    
    // Add scheduled task detection: ⏳ YYYY-MM-DD
    let scheduledDate: string | undefined = undefined;
    let taskType: "repeated-daily" | "scheduled" | "regular" = "regular";
    const scheduledMatch = /⏳\s*(\d{4}-\d{2}-\d{2})/.exec(line);
    if (scheduledMatch) {
        scheduledDate = scheduledMatch[1];
        taskType = "scheduled";
    } else if (habitType) {
        taskType = "repeated-daily";
    }
    
    // Add start date parsing
    let startDate: string | undefined = undefined;
    const startMatch = /➕\s*(\d{4}-\d{2}-\d{2})/.exec(line);
    if (startMatch) {
        startDate = startMatch[1];
    }
    
    // Add attribute parsing
    let attributeName: string | undefined = undefined;
    const attributeMatch = /\[attribute::\s*([^\]\s]+)\]/i.exec(line);
    if (attributeMatch) {
        attributeName = attributeMatch[1];
    }
    
    // Return task if it has any of the special properties
    if (isUrgent === undefined && isImportant === undefined && !habitType && !accumulated && !scheduledDate && !startDate && !attributeName) return null;
    
    return {
        content: line,
        importance: isImportant ? "high" : "low",
        urgency: isUrgent ? "high" : "low",
        durationMinutes: parseInt(durationMinutes),
        file,
        line: lineNumber,
        habitType,
        accumulated: accumulated || false,
        accumulatedCount: accumulated ? (accumulatedCount ?? 0) : undefined,
        lastDoneDate,
        taskType,
        scheduledDate,
        startDate,
        currentStreak,
        maxStreak,
        lastStreakDate,
        attributeName,
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
function sortHabitTasks<T extends EisenhowerTask>(tasks: T[], sortKey: 'progress' | 'startDate' | 'default', direction: 'asc' | 'desc'): T[] {
    if (sortKey === 'default') {
        return [...tasks];
    }

    const modifier = direction === 'asc' ? 1 : -1;

    return [...tasks].sort((a, b) => {
        if (sortKey === 'progress') {
            const aIsAccumulated = a.accumulated ?? false;
            const bIsAccumulated = b.accumulated ?? false;
            if (aIsAccumulated && !bIsAccumulated) return -1;
            if (!aIsAccumulated && bIsAccumulated) return 1;
            if (aIsAccumulated && bIsAccumulated) {
                // Natural sort is descending (b-a). Modifier will flip it if needed.
                return ((b.accumulatedCount ?? 0) - (a.accumulatedCount ?? 0)) * modifier;
            }
            return 0;
        }

        if (sortKey === 'startDate') {
            const aDate = a.startDate;
            const bDate = b.startDate;
            if (aDate && !bDate) return -1; // Tasks with dates always come first
            if (!aDate && bDate) return 1;
            if (aDate && bDate) {
                // Natural sort is ascending (a.localeCompare(b)). Modifier will flip it.
                return aDate.localeCompare(bDate) * modifier;
            }
            return 0;
        }

        return 0;
    });
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
            .replace(/\[[^:\[\]]*::[^\[\]]*\]/g, "") // Remove all [property::value] patterns
            .replace(/🔁\s*every day/gi, "") // Remove "🔁 every day"
            .replace(/🔁/g, "") // Remove standalone 🔁
            .replace(/➕\s*\d{4}-\d{2}-\d{2}/g, "") // Remove ➕ YYYY-MM-DD
            .replace(/🛫\s*\d{4}-\d{2}-\d{2}/g, "") // Remove 🛫 YYYY-MM-DD
            .replace(/✅\s*\d{4}-\d{2}-\d{2}/g, "") // Remove ✅ YYYY-MM-DD
            .replace(/⭐|🔥|🔄|🪙/g, "") // Remove other task emojis
            .replace(/⏳\s*\d{4}-\d{2}-\d{2}/g, "") // Remove scheduled dates
            .replace(/⏳\d*/g, "") // Remove duration emojis
            .replace(/\[\d*\]/g, "") // Remove any [] or [number]
            .replace(/\[\s*\]/g, "") // Remove empty []
            .replace(/\s+/g, " ") // Clean up multiple spaces
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
        display: flex;
        align-items: center;
      }
      .eisenhower-matrix-task.done {
        text-decoration: line-through;
        opacity: 0.6;
        cursor: default;
      }
      .eisenhower-matrix-checkbox {
        margin-right: 8px;
      }
    </style>
    <div class="eisenhower-matrix-grid">
      <div class="eisenhower-matrix-cell" style="background:${quadrantColors["Urgent & Important"]}">
        <div class="eisenhower-matrix-title">${settings.matrixUrgencyEmoji}${settings.matrixImportanceEmoji} Urgent & Important</div>
        <ul>
          ${groups["Urgent & Important"].map((t, idx) => renderMatrixTaskLi(t)).join("") || '<li class="eisenhower-matrix-task" style="color:#aaa">No tasks</li>'}
        </ul>
      </div>
      <div class="eisenhower-matrix-cell" style="background:${quadrantColors["Not Urgent but Important"]}">
        <div class="eisenhower-matrix-title">${settings.matrixImportanceEmoji} Not Urgent but Important</div>
        <ul>
          ${groups["Not Urgent but Important"].map((t, idx) => renderMatrixTaskLi(t)).join("") || '<li class="eisenhower-matrix-task" style="color:#aaa">No tasks</li>'}
        </ul>
      </div>
      <div class="eisenhower-matrix-cell" style="background:${quadrantColors["Urgent but Not Important"]}">
        <div class="eisenhower-matrix-title">${settings.matrixUrgencyEmoji} Urgent but Not Important</div>
        <ul>
          ${groups["Urgent but Not Important"].map((t, idx) => renderMatrixTaskLi(t)).join("") || '<li class="eisenhower-matrix-task" style="color:#aaa">No tasks</li>'}
        </ul>
      </div>
      <div class="eisenhower-matrix-cell" style="background:${quadrantColors["Neither Urgent nor Important"]}">
        <div class="eisenhower-matrix-title">Neither Urgent nor Important</div>
        <ul>
          ${groups["Neither Urgent nor Important"].map((t, idx) => renderMatrixTaskLi(t)).join("") || '<li class="eisenhower-matrix-task" style="color:#aaa">No tasks</li>'}
        </ul>
      </div>
    </div>
    <script>
      (function() {
        function getTodayDateStr() {
          const d = new Date();
          return d.toISOString().slice(0, 10);
        }
        const tasks = document.querySelectorAll('.eisenhower-matrix-task[data-file][data-line]');
        tasks.forEach(el => {
          const lastDone = el.getAttribute('data-last-done');
          const isDoneToday = lastDone === getTodayDateStr();
          if (isDoneToday) el.classList.add('done');
          // Add checkbox
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.className = 'eisenhower-matrix-checkbox';
          checkbox.checked = isDoneToday;
          checkbox.disabled = isDoneToday;
          el.insertBefore(checkbox, el.firstChild);
          checkbox.addEventListener('change', async function() {
            if (checkbox.checked && !isDoneToday) {
              el.classList.add('done');
              checkbox.disabled = true;
              // Mark as done in file via Obsidian API
              if (window.app && window.app.plugins && window.app.plugins.plugins) {
                // Find the plugin more reliably
                let plugin = null;
                for (const [id, p] of Object.entries(window.app.plugins.plugins)) {
                  if (p && p._markEisenhowerTaskDone && p._markHabitTaskDoneWithDate) {
                    plugin = p;
                    break;
                  }
                }
                
                if (plugin) {
                  const taskType = el.getAttribute('data-task-type') || 'regular';
                  const filePath = el.getAttribute('data-file');
                  const lineNumber = parseInt(el.getAttribute('data-line'), 10);
                  const originalContent = decodeURIComponent(el.getAttribute('data-content'));
                  
                  try {
                    if (taskType === 'repeated-daily' && plugin._markHabitTaskDoneWithDate) {
                      // For habit tasks, use the date-based completion
                      await plugin._markHabitTaskDoneWithDate(filePath, lineNumber, originalContent);
                    } else if (plugin._markEisenhowerTaskDone) {
                      // For regular Eisenhower tasks, mark as [x]
                      await plugin._markEisenhowerTaskDone(filePath, lineNumber, originalContent);
                    }
                  } catch (error) {
                    console.error('Error marking task as done:', error);
                    // Revert UI changes on error
                    el.classList.remove('done');
                    checkbox.checked = false;
                    checkbox.disabled = false;
                  }
                }
              }
            }
          });
          // Clicking the label opens the file
          el.addEventListener('click', function(e) {
            if (e.target === checkbox) return;
            const file = decodeURIComponent(el.getAttribute('data-file'));
            const line = parseInt(el.getAttribute('data-line'), 10);
            if (window.app && window.app.workspace) {
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
    function renderMatrixTaskLi(t: EisenhowerTask) {
        // Add data-last-done for daily/weekly habits
        const lastDoneAttr = t.lastDoneDate ? `data-last-done="${t.lastDoneDate}"` : "";
        const taskTypeAttr = t.taskType ? `data-task-type="${t.taskType}"` : 'data-task-type="regular"';
        return `<li class='eisenhower-matrix-task' data-file='${encodeURIComponent(t.file)}' data-line='${t.line}' data-content='${encodeURIComponent(t.content)}' ${taskTypeAttr} ${lastDoneAttr}>${escapeHtml(stripProps(t.content))}</li>`;
    }
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
    enableStreakTracking: boolean;
    dailyNotePath: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
    headerText: "היום",
    promptTemplate: `סכם את הטקסט הבא , \nלמד מה היה טוב ועבד טוב , מה הזיק לאנרגיה והיה שלילי ומצא תובנות חשובות\n{days}`,
    matrixImportanceEmoji: "⭐",
    matrixUrgencyEmoji: "🔥",
    matrixDurationEmoji: "⏳",
    enableStreakTracking: true,
    dailyNotePath: ""
};

// Add workspace pane view types
const DAILY_HABIT_TRACKER_VIEW_TYPE = "daily-habit-tracker-view";
const EISENHOWER_MATRIX_VIEW_TYPE = "eisenhower-matrix-view";

// Modern Eisenhower Matrix View with drag-and-drop
class EisenhowerMatrixView extends ItemView {
    plugin: MyPlugin;
    matrixTasks: EisenhowerTask[] = [];
    private _refreshTimer: number | null = null;
    private _lastTasksJson: string = "";
    
    constructor(leaf: WorkspaceLeaf, plugin: MyPlugin) {
        super(leaf);
        this.plugin = plugin;
    }
    
    getViewType() { return EISENHOWER_MATRIX_VIEW_TYPE; }
    getDisplayText() { return "Eisenhower Matrix"; }
    getIcon() { return "grid-3x3"; }
    
    async onOpen() {
        await this.reloadAndRender();
        // Auto-refresh every 5 seconds
        this._refreshTimer = window.setInterval(async () => {
            await this.reloadAndRender();
        }, 5000);
    }
    
    async onClose() {
        if (this._refreshTimer) {
            window.clearInterval(this._refreshTimer);
            this._refreshTimer = null;
        }
    }
    
    async reloadAndRender() {
        const files = this.plugin.app.vault.getMarkdownFiles();
        let tasks: EisenhowerTask[] = [];
        
        for (const file of files) {
            const content = await this.plugin.app.vault.read(file);
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (/^- \[ \]/.test(line)) {
                    const hasImportance = /importance::\s*(high|low)/.test(line) || /⭐/.test(line);
                    const hasUrgency = /urgency::\s*(high|low)/.test(line) || /🔥/.test(line);
                    if (hasImportance || hasUrgency) {
                        const task = parseTask(line, file.path, i + 1);
                        if (task) tasks.push(task);
                    }
                }
            }
        }
        
        const newTasksJson = JSON.stringify(tasks.map(t => ({
            file: t.file, line: t.line, content: t.content, importance: t.importance, urgency: t.urgency
        })));
        
        if (newTasksJson !== this._lastTasksJson) {
            this.matrixTasks = tasks;
            this._lastTasksJson = newTasksJson;
            this.renderMatrix();
        }
    }
    
    renderMatrix() {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        
        // Add modern styling with flexible layout
        const styleEl = container.createEl("style");
        styleEl.textContent = `
            .matrix-container { 
                padding: 16px; 
                height: 100%; 
                overflow: hidden;
                display: flex;
                flex-direction: column;
                max-height: 100vh;
            }
            .matrix-grid { 
                display: grid; 
                grid-template-columns: 1fr 1fr; 
                grid-template-rows: 1fr 1fr; 
                gap: 16px; 
                flex: 1;
                min-height: 0;
                overflow: hidden;
            }
            .matrix-quadrant { 
                border: 2px solid #ddd; 
                border-radius: 12px; 
                padding: 16px; 
                overflow: hidden;
                transition: all 0.3s ease;
                position: relative;
                display: flex;
                flex-direction: column;
                min-height: 0;
            }
            .matrix-quadrant.drag-over { 
                border-color: #007acc; 
                background-color: rgba(0, 122, 204, 0.1); 
                transform: scale(1.02);
            }
            .matrix-title { 
                font-weight: bold; 
                font-size: 1.1em; 
                margin-bottom: 12px; 
                padding-bottom: 8px;
                border-bottom: 1px solid #eee;
                flex-shrink: 0;
            }
            .matrix-quadrant-content {
                flex: 1;
                overflow-y: auto;
                overflow-x: hidden;
                min-height: 0;
                scrollbar-width: thin;
                scrollbar-color: #ccc transparent;
            }
            .matrix-quadrant-content::-webkit-scrollbar {
                width: 6px;
            }
            .matrix-quadrant-content::-webkit-scrollbar-track {
                background: transparent;
            }
            .matrix-quadrant-content::-webkit-scrollbar-thumb {
                background-color: #ccc;
                border-radius: 3px;
            }
            .matrix-quadrant-content::-webkit-scrollbar-thumb:hover {
                background-color: #999;
            }
            .matrix-task { 
                background: white;
                border: 1px solid #ddd;
                border-radius: 8px;
                padding: 12px;
                margin-bottom: 8px;
                cursor: grab;
                transition: all 0.2s ease;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                word-wrap: break-word;
                overflow-wrap: break-word;
                hyphens: auto;
            }
            .matrix-task:hover { 
                transform: translateY(-2px);
                box-shadow: 0 4px 8px rgba(0,0,0,0.15);
                border-color: #007acc;
            }
            .matrix-task.dragging { 
                opacity: 0.5; 
                transform: rotate(5deg);
                cursor: grabbing;
            }
            .task-content { 
                font-weight: 500; 
                margin-bottom: 6px; 
                line-height: 1.4;
                word-break: break-word;
            }
            .task-meta { 
                font-size: 0.85em; 
                color: #666; 
                display: flex; 
                gap: 8px; 
                align-items: center;
                flex-wrap: wrap;
            }
            .task-badge { 
                background: #f0f0f0; 
                padding: 2px 6px; 
                border-radius: 4px; 
                font-size: 0.8em;
                white-space: nowrap;
            }
            .task-actions { 
                margin-top: 8px; 
                display: flex; 
                gap: 6px;
                flex-wrap: wrap;
            }
            .task-btn { 
                background: #007acc; 
                color: white; 
                border: none; 
                padding: 4px 8px; 
                border-radius: 4px; 
                cursor: pointer; 
                font-size: 0.8em;
                transition: background 0.2s;
                white-space: nowrap;
            }
            .task-btn:hover { background: #005999; }
            .task-btn.complete { background: #28a745; }
            .task-btn.complete:hover { background: #1e7e34; }
            .empty-message {
                color: #999;
                font-style: italic;
                text-align: center;
                padding: 20px;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 100%;
                min-height: 60px;
            }
            .quadrant-urgent-important { background: linear-gradient(135deg, #ffebee 0%, #ffcdd2 100%); }
            .quadrant-important { background: linear-gradient(135deg, #fff8e1 0%, #ffecb3 100%); }
            .quadrant-urgent { background: linear-gradient(135deg, #e3f2fd 0%, #bbdefb 100%); }
            .quadrant-neither { background: linear-gradient(135deg, #f5f5f5 0%, #eeeeee 100%); }
            
            /* Responsive adjustments */
            @media (max-width: 768px) {
                .matrix-grid {
                    grid-template-columns: 1fr;
                    grid-template-rows: repeat(4, 1fr);
                }
                .matrix-container {
                    padding: 8px;
                }
                .matrix-quadrant {
                    padding: 12px;
                }
            }
        `;
        
        const mainContainer = container.createDiv({ cls: "matrix-container" });
        const header = mainContainer.createEl("h2", { text: "🎯 Eisenhower Matrix" });
        header.style.marginBottom = "16px";
        
        const grid = mainContainer.createDiv({ cls: "matrix-grid" });
        
        const groups = groupTasks(this.matrixTasks);
        this.createQuadrant(grid, "🔥⭐ Urgent & Important", groups["Urgent & Important"], "urgent-important", "high", "high");
        this.createQuadrant(grid, "⭐ Not Urgent but Important", groups["Not Urgent but Important"], "important", "high", "low");
        this.createQuadrant(grid, "🔥 Urgent but Not Important", groups["Urgent but Not Important"], "urgent", "low", "high");
        this.createQuadrant(grid, "📋 Neither Urgent nor Important", groups["Neither Urgent nor Important"], "neither", "low", "low");
    }
    
    createQuadrant(grid: HTMLElement, title: string, tasks: EisenhowerTask[], className: string, importance: string, urgency: string) {
        const quadrant = grid.createDiv({ cls: `matrix-quadrant quadrant-${className}` });
        quadrant.setAttribute("data-importance", importance);
        quadrant.setAttribute("data-urgency", urgency);
        
        const titleEl = quadrant.createDiv({ cls: "matrix-title", text: title });
        
        // Create scrollable content container
        const contentContainer = quadrant.createDiv({ cls: "matrix-quadrant-content" });
        
        // Add drag-and-drop handlers
        quadrant.addEventListener("dragover", (e) => {
            e.preventDefault();
            quadrant.classList.add("drag-over");
        });
        
        quadrant.addEventListener("dragleave", () => {
            quadrant.classList.remove("drag-over");
        });
        
        quadrant.addEventListener("drop", async (e) => {
            e.preventDefault();
            quadrant.classList.remove("drag-over");
            
            const taskData = e.dataTransfer?.getData("text/plain");
            if (taskData) {
                const task = JSON.parse(taskData) as EisenhowerTask;
                await this.moveTaskToQuadrant(task, importance as "high" | "low", urgency as "high" | "low");
            }
        });
        
        // Add tasks to the scrollable content container
        tasks.forEach(task => this.createTaskElement(contentContainer, task));
        
        if (tasks.length === 0) {
            const emptyMsg = contentContainer.createDiv({ 
                cls: "empty-message",
                text: "No tasks in this quadrant"
            });
        }
    }
    
    createTaskElement(container: HTMLElement, task: EisenhowerTask) {
        const taskEl = container.createDiv({ cls: "matrix-task" });
        taskEl.draggable = true;
        
        const content = taskEl.createDiv({ cls: "task-content" });
        content.textContent = formatTaskContent(task.content);
        
        const meta = taskEl.createDiv({ cls: "task-meta" });
        if (task.durationMinutes > 0) {
            const duration = meta.createSpan({ cls: "task-badge", text: `⏳ ${task.durationMinutes}min` });
        }
        if (task.taskType === "repeated-daily") {
            meta.createSpan({ cls: "task-badge", text: "🔁 Habit" });
        }
        if (task.accumulated) {
            meta.createSpan({ cls: "task-badge", text: `🪙 ${task.accumulatedCount ?? 0}` });
        }
        
        const actions = taskEl.createDiv({ cls: "task-actions" });
        const completeBtn = actions.createEl("button", { cls: "task-btn complete", text: "✓ Complete" });
        const openBtn = actions.createEl("button", { cls: "task-btn", text: "📝 Open" });
        
        // Event handlers
        taskEl.addEventListener("dragstart", (e) => {
            taskEl.classList.add("dragging");
            e.dataTransfer?.setData("text/plain", JSON.stringify(task));
        });
        
        taskEl.addEventListener("dragend", () => {
            taskEl.classList.remove("dragging");
        });
        
        completeBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            await this.completeTask(task);
        });
        
        openBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            await this.openTask(task);
        });
        
        taskEl.addEventListener("click", () => this.openTask(task));
    }
    
    async moveTaskToQuadrant(task: EisenhowerTask, newImportance: "high" | "low", newUrgency: "high" | "low") {
        if (task.importance === newImportance && task.urgency === newUrgency) return;
        
        const file = this.plugin.app.vault.getAbstractFileByPath(task.file);
        if (!(file instanceof TFile)) return;
        
        const content = await this.plugin.app.vault.read(file);
        const lines = content.split(/\r?\n/);
        let line = lines[task.line - 1];
        
        // Update importance and urgency properties
        line = line.replace(/\[importance::\s*(high|low)\]/gi, `[importance::${newImportance}]`);
        line = line.replace(/\[urgency::\s*(high|low)\]/gi, `[urgency::${newUrgency}]`);
        
        // Add properties if they don't exist
        if (!/\[importance::/i.test(line)) {
            line += ` [importance::${newImportance}]`;
        }
        if (!/\[urgency::/i.test(line)) {
            line += ` [urgency::${newUrgency}]`;
        }
        
        lines[task.line - 1] = line;
        await this.plugin.app.vault.modify(file, lines.join("\n"));
        
        new Notice(`Task moved to ${newImportance === "high" ? "Important" : "Not Important"} & ${newUrgency === "high" ? "Urgent" : "Not Urgent"}`);
        
        // Refresh the view
        setTimeout(() => this.reloadAndRender(), 100);
    }
    
    async completeTask(task: EisenhowerTask) {
        if (task.taskType === "repeated-daily") {
            await this.plugin._markHabitTaskDoneWithDate(task.file, task.line, task.content);
        } else {
            await this.plugin._markEisenhowerTaskDone(task.file, task.line, task.content);
        }
        setTimeout(() => this.reloadAndRender(), 100);
    }
    
    async openTask(task: EisenhowerTask) {
        const file = this.plugin.app.vault.getAbstractFileByPath(task.file);
        if (file instanceof TFile) {
            await this.plugin.app.workspace.openLinkText(task.file, '', false);
            const leaf = this.plugin.app.workspace.getMostRecentLeaf();
            if (leaf && leaf.view instanceof MarkdownView) {
                const editor = leaf.view.editor;
                if (editor) {
                    editor.setCursor({ line: task.line - 1, ch: 0 });
                }
            }
        }
    }
}

class DailyHabitTrackerView extends ItemView {
    plugin: MyPlugin;
    habitTasks: (EisenhowerTask & { type: "daily" | "weekly" | "scheduled" })[] = [];
    private _refreshTimer: number | null = null;
    private _lastTasksJson: string = "";
    private _lastModifiedTimes: Map<string, number> = new Map();
    private isGrouped: boolean = false;
    private currentSortOrder: 'progress' | 'startDate' | 'default' = 'default';
    private currentSortDirection: 'asc' | 'desc' = 'asc';
    constructor(leaf: WorkspaceLeaf, plugin: MyPlugin) {
        super(leaf);
        this.plugin = plugin;
    }
    getViewType() { return DAILY_HABIT_TRACKER_VIEW_TYPE; }
    getDisplayText() { return "Daily Habit Tracker"; }
    async onOpen() {
        await this.reloadAndRender();
        // Set up auto-refresh every 4 seconds
        this._refreshTimer = window.setInterval(async () => {
            await this.reloadAndRender();
        }, 4000);
    }
    
    async onClose() {
        if (this._refreshTimer) {
            window.clearInterval(this._refreshTimer);
            this._refreshTimer = null;
        }
    }
    async reloadAndRender() {
        const files = this.plugin.app.vault.getMarkdownFiles();
        let tasks: EisenhowerTask[] = [];
        const today = new Date().toISOString().slice(0, 10);
        
        for (const file of files) {
            const content = await this.plugin.app.vault.read(file);
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (/^- \[ \]/.test(line)) {
                    const task = parseTask(line, file.path, i + 1);
                    if (task) {
                        // Handle repeated daily/weekly habits
                        if (task.habitType) {
                            // Show if not done today, or if done today (for visual feedback)
                            if (!task.lastDoneDate || task.lastDoneDate !== today) {
                                tasks.push(task);
                            } else if (task.lastDoneDate === today) {
                                // Include done tasks for display but mark them differently
                                tasks.push(task);
                            }
                        }
                        // Handle scheduled tasks (⏳ YYYY-MM-DD)
                        else if (task.taskType === "scheduled" && task.scheduledDate === today) {
                            tasks.push(task);
                        }
                    }
                }
            }
        }
        
        const newTasks = tasks.map(task => ({ 
            ...task, 
            type: task.taskType === "scheduled" ? "scheduled" : (task.habitType || "daily")
        })) as (EisenhowerTask & { type: "daily" | "weekly" | "scheduled" })[];
        
        const newTasksJson = JSON.stringify(newTasks.map(t => ({
            file: t.file, line: t.line, content: t.content, accumulated: t.accumulated, 
            accumulatedCount: t.accumulatedCount, lastDoneDate: t.lastDoneDate, 
            type: t.type, taskType: t.taskType, scheduledDate: t.scheduledDate
        })));
        
        if (newTasksJson !== this._lastTasksJson) {
            this.habitTasks = newTasks;
            this._lastTasksJson = newTasksJson;
            this.renderUI();
        }
    }
    renderUI() {
        const container = this.containerEl.children[1];
        container.empty();
        
        // Add flexible styling for habit tracker
        const styleEl = document.createElement("style");
        styleEl.textContent = `
            .habit-tracker-container {
                padding: 16px;
                height: 100%;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                max-height: 100vh;
            }
            .habit-tracker-header {
                flex-shrink: 0;
                border-bottom: 1px solid #eee;
                padding-bottom: 8px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                flex-wrap: wrap;
                gap: 8px;
                margin-bottom: 16px;
            }
            .habit-tracker-controls {
                display: flex;
                align-items: center;
                gap: 16px;
                font-size: 0.9em;
            }
            .habit-tracker-content {
                flex: 1;
                overflow-y: auto;
                overflow-x: hidden;
                min-height: 0;
                scrollbar-width: thin;
                scrollbar-color: #ccc transparent;
            }
            .habit-tracker-content::-webkit-scrollbar {
                width: 6px;
            }
            .habit-tracker-content::-webkit-scrollbar-track {
                background: transparent;
            }
            .habit-tracker-content::-webkit-scrollbar-thumb {
                background-color: #ccc;
                border-radius: 3px;
            }
            .habit-tracker-content::-webkit-scrollbar-thumb:hover {
                background-color: #999;
            }
            .habit-tracker-section { 
                margin-bottom: 24px; 
            }
            .habit-tracker-title { 
                font-weight: bold; 
                font-size: 1.1em; 
                margin-bottom: 12px; 
                padding: 8px;
                background: rgba(0, 0, 0, 0.02);
                border-radius: 6px;
                border-left: 4px solid #007acc;
            }
            .habit-tracker-list { 
                list-style: none; 
                padding: 0; 
                margin: 0;
            }
            .habit-tracker-item { 
                margin-bottom: 8px; 
                padding: 12px; 
                border-radius: 8px; 
                display: flex; 
                align-items: center; 
                border: 2px solid; 
                transition: all 0.3s ease;
                word-wrap: break-word;
                overflow-wrap: break-word;
                min-height: 44px;
            }
            .habit-tracker-item:hover { 
                transform: translateY(-1px); 
                box-shadow: 0 4px 12px rgba(0,0,0,0.15); 
            }
            .habit-tracker-checkbox { 
                margin-right: 12px; 
                flex-shrink: 0;
            }
            .habit-tracker-label { 
                flex: 1; 
                font-weight: 500;
                line-height: 1.4;
                word-break: break-word;
                min-width: 0;
            }
            .habit-tracker-label.accumulated-task-content {
                flex: 2;
                min-width: 50%;
                margin-right: 8px;
            }
            .accumulated-btn { 
                border-radius: 8px; 
                padding: 12px; 
                cursor: pointer; 
                display: flex; 
                align-items: center; 
                margin: 2px; 
                font-weight: bold; 
                transition: all 0.3s ease; 
                border: 2px solid;
                min-height: 44px;
                flex: 1;
                word-wrap: break-word;
                overflow-wrap: break-word;
            }
            .accumulated-btn:hover { 
                transform: translateY(-2px); 
                box-shadow: 0 6px 16px rgba(0,0,0,0.2); 
            }
            .accumulated-btn:active { 
                filter: brightness(0.95); 
                transform: translateY(-1px);
            }
            .accumulated-btn > span {
                word-break: break-word;
                min-width: 0;
            }
            .count-badge { 
                border-radius: 12px; 
                padding: 6px 10px; 
                margin-left: 12px; 
                font-weight: bold; 
                font-size: 0.9em;
                flex-shrink: 0;
                white-space: nowrap;
            }
            .achievement-badge { 
                margin-left: 8px; 
                font-size: 1.2em;
                flex-shrink: 0;
            }
            .achievement-level { 
                font-size: 0.8em; 
                margin-left: 8px; 
                opacity: 0.8; 
                font-style: italic;
                flex-shrink: 0;
                white-space: nowrap;
            }
            .accumulated-controls {
                display: grid;
                grid-template-columns: 1fr;
                grid-template-rows: auto auto;
                gap: 4px;
                flex: 1;
                min-width: 35%;
                max-width: 40%;
            }
            .accumulated-btn.increment {
                grid-column: 1;
                grid-row: 1;
                padding: 8px 6px;
                border-radius: 6px;
                border: 2px solid;
                font-size: 0.8em;
                cursor: pointer;
                transition: all 0.2s ease;
                font-weight: 600;
                text-align: center;
                display: flex;
                align-items: center;
                justify-content: center;
                min-height: 36px;
            }
            .accumulated-btn.increment:hover {
                opacity: 0.9;
                transform: translateY(-1px);
            }
            .achievement-info {
                grid-column: 1;
                grid-row: 1;
                display: flex;
                flex-direction: column;
                align-items: center;
                margin-right: 8px;
            }
            .achievement-badge-inline { 
                font-size: 1.4em;
                margin-bottom: 2px;
            }
            .achievement-level-inline {
                font-size: 0.65em;
                opacity: 0.8;
                font-style: italic;
                text-align: center;
                line-height: 1;
                white-space: nowrap;
            }
            .secondary-controls { 
                grid-column: 1;
                grid-row: 2;
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 3px;
            }
            .negative-btn { 
                padding: 4px 6px; 
                border-radius: 4px; 
                border: 1px solid; 
                font-size: 0.7em; 
                cursor: pointer;
                transition: all 0.2s ease;
                text-align: center;
                font-weight: 500;
            }
            .negative-btn.decrement { 
                background: #ffecb3; 
                border-color: #ffc107; 
                color: #e65100; 
            }
            .negative-btn.reset { 
                background: #e1f5fe; 
                border-color: #03a9f4; 
                color: #01579b; 
            }
            .negative-btn:hover { 
                opacity: 0.8; 
                transform: translateY(-1px);
            }
            .achievement-indicator {
                position: absolute;
                bottom: 8px;
                left: 8px;
                font-size: 1.1em;
                opacity: 0.9;
                cursor: help;
                z-index: 1;
                transition: all 0.2s ease;
            }
            .achievement-indicator:hover {
                transform: scale(1.2);
                opacity: 1;
            }
            
            /* Responsive adjustments for standard pane sizes */
            @media (max-width: 500px) {
                .habit-tracker-container {
                    padding: 8px;
                }
                .habit-tracker-item {
                    padding: 8px;
                    flex-direction: column;
                    align-items: stretch;
                }
                .habit-tracker-checkbox {
                    margin-right: 0;
                    margin-bottom: 8px;
                    align-self: flex-start;
                }
                .accumulated-btn {
                    flex-direction: column;
                    align-items: stretch;
                    text-align: center;
                }
                .accumulated-btn > span {
                    margin: 2px 0;
                }
                .count-badge {
                    margin-left: 0;
                    margin-top: 4px;
                    align-self: center;
                }
                .achievement-badge {
                    margin-left: 0;
                    align-self: center;
                }
                .achievement-level {
                    margin-left: 0;
                    text-align: center;
                }
                .negative-controls {
                    margin-left: 0;
                    margin-top: 8px;
                    justify-content: center;
                }
            }
            
            /* Additional adjustments for very narrow panes */
            @media (max-width: 350px) {
                .habit-tracker-item {
                    padding: 6px;
                }
                .accumulated-btn {
                    padding: 8px;
                    font-size: 0.9em;
                }
                .count-badge {
                    padding: 4px 8px;
                    font-size: 0.8em;
                }
                .negative-btn {
                    padding: 3px 6px;
                    font-size: 0.75em;
                }
            }
        `;
        container.appendChild(styleEl);
        
        // Create main container with flexible layout
        const mainContainer = (container as HTMLElement).createDiv({ cls: "habit-tracker-container" });
        
        // Create header
        const header = mainContainer.createDiv({ cls: "habit-tracker-header" });
        header.createEl("h2", { text: "Daily Habit Tracker" }).style.margin = "0";

        // Add UI Controls for sorting and grouping
        const controlsContainer = header.createDiv({ cls: "habit-tracker-controls" });

        // Grouping Toggle
        const groupToggleLabel = controlsContainer.createEl("label", { attr: { style: "display: flex; align-items: center; gap: 4px; cursor: pointer;" } });
        const groupToggle = groupToggleLabel.createEl("input", { type: "checkbox" });
        groupToggle.checked = this.isGrouped;
        groupToggle.onchange = () => {
            this.isGrouped = groupToggle.checked;
            this.renderUI(); // Re-render
        };
        groupToggleLabel.appendText("Group by Type");

        // Sorting Dropdown
        const sortDropdownLabel = controlsContainer.createEl("label", { attr: { style: "display: flex; align-items: center; gap: 4px; cursor: pointer;" } });
        sortDropdownLabel.appendText("Sort by:");
        const sortDropdown = sortDropdownLabel.createEl("select");
        sortDropdown.createEl("option", { value: "default", text: "Default" });
        sortDropdown.createEl("option", { value: "progress", text: "Progress" });
        sortDropdown.createEl("option", { value: "startDate", text: "Start Date" });
        sortDropdown.value = this.currentSortOrder;
        sortDropdown.onchange = () => {
            this.currentSortOrder = sortDropdown.value as 'progress' | 'startDate' | 'default';
            // Set default direction when sort type changes
            if (this.currentSortOrder === 'progress') {
                this.currentSortDirection = 'desc'; // Progress is better when high
            } else {
                this.currentSortDirection = 'asc'; // Start date is better when early
            }
            this.renderUI(); // Re-render
        };

        // Add Sort Direction Toggle Button
        if (this.currentSortOrder !== 'default') {
            const sortDirectionToggle = controlsContainer.createEl("button", {
                text: this.currentSortDirection === 'asc' ? '↑ Asc' : '↓ Desc',
                attr: { 
                    style: "padding: 4px 8px; font-size: 0.9em; cursor: pointer; border-radius: 4px; border: 1px solid #ccc; background: #f0f0f0;",
                    title: "Toggle sort direction"
                }
            });
            sortDirectionToggle.onclick = () => {
                this.currentSortDirection = this.currentSortDirection === 'asc' ? 'desc' : 'asc';
                this.renderUI();
            };
        }
        
        // Create scrollable content area
        const content = mainContainer.createDiv({ cls: "habit-tracker-content" });
        
        // Apply sorting and grouping
        const processedTasks = sortHabitTasks(this.habitTasks, this.currentSortOrder, this.currentSortDirection);

        if (this.isGrouped) {
            this.createHabitSection(content, "🪙 Accumulated Habits", processedTasks.filter(t => t.accumulated));
            this.createHabitSection(content, "🔁 Simple Habits", processedTasks.filter(t => !t.accumulated));
        } else {
            this.createHabitSection(content, "🔄 Daily Habits", processedTasks.filter(t => t.type === "daily"));
            this.createHabitSection(content, "🔁 Weekly Habits", processedTasks.filter(t => t.type === "weekly"));
            this.createHabitSection(content, "⏳ Today's Scheduled Tasks", processedTasks.filter(t => t.type === "scheduled"));
        }
    }
    createHabitSection(container: HTMLElement, title: string, tasks: (EisenhowerTask & { type: "daily" | "weekly" | "scheduled" })[]) {
        const section = container.createDiv({ cls: "habit-tracker-section" });
        section.createDiv({ text: title, cls: "habit-tracker-title" });
        const list = section.createEl("ul", { cls: "habit-tracker-list" });
        if (tasks.length === 0) {
            list.createEl("li", { text: `No ${title.toLowerCase().includes("daily") ? "daily" : "weekly"} habits found`, attr: { style: "color:#aaa;" } });
            return section;
        }
        tasks.forEach(task => {
            const item = list.createEl("li", { cls: "habit-tracker-item" });
            
            // Apply motivational colors based on accumulated count
            const count = task.accumulatedCount ?? 0;
            const colors = getMotivationalColor(count);
            const achievementLevel = getAchievementLevel(count);
            
            // Set dynamic colors for the item
            item.style.backgroundColor = colors.background;
            item.style.borderColor = colors.border;
            item.style.color = colors.textColor;
            
            // Add click handler to open file and focus line
            item.addEventListener("click", (e) => {
                if ((e.target as HTMLElement).tagName === "BUTTON" || (e.target as HTMLElement).tagName === "INPUT") return;
                const file = this.plugin.app.vault.getAbstractFileByPath(task.file);
                if (file instanceof TFile) {
                    this.plugin.app.workspace.openLinkText(task.file, '', false).then(() => {
                        const leaf = this.plugin.app.workspace.getMostRecentLeaf();
                        if (leaf && leaf.view instanceof MarkdownView) {
                            const editor = leaf.view.editor;
                            if (editor) {
                                editor.setCursor({ line: task.line - 1, ch: 0 });
                            }
                        }
                    });
                }
            });
            
            if (task.accumulated) {
                // Create task label with content (takes most space)
                const label = item.createEl("span", { text: formatTaskContent(task.content), cls: "habit-tracker-label accumulated-task-content" });
                
                // Create compact achievement emoji indicator (bottom-left corner)
                const achievementIndicator = item.createSpan({ 
                    cls: "achievement-indicator", 
                    text: colors.badge,
                    title: `${achievementLevel} (${count} completions)` // Tooltip with full info
                });
                
                // Create ultra-compact controls container
                const controlsContainer = item.createDiv({ cls: "accumulated-controls" });
                
                // Add main increment button (grid row 1)
                const incrementBtn = controlsContainer.createEl("button", { 
                    cls: "accumulated-btn increment", 
                    text: `+1 (${count})` 
                });
                incrementBtn.style.backgroundColor = colors.background;
                incrementBtn.style.borderColor = colors.border;
                incrementBtn.style.color = colors.textColor;
                
                // Add secondary controls container (grid row 2) - only if count > 0
                if (count > 0) {
                    const secondaryControls = controlsContainer.createDiv({ cls: "secondary-controls" });
                    
                    const decrementBtn = secondaryControls.createEl("button", { 
                        cls: "negative-btn decrement", text: "-1" 
                    });
                    decrementBtn.addEventListener("click", async (e) => {
                        e.stopPropagation();
                        await this.plugin._decrementAccumulatedTask(task.file, task.line, task.content);
                        await this.reloadAndRender();
                    });
                    
                    const resetBtn = secondaryControls.createEl("button", { 
                        cls: "negative-btn reset", text: "Reset" 
                    });
                    resetBtn.addEventListener("click", async (e) => {
                        e.stopPropagation();
                        await this.plugin._clearAccumulatedTask(task.file, task.line, task.content);
                        await this.reloadAndRender();
                    });
                }
                
                // Main increment click handler
                incrementBtn.addEventListener("click", async () => {
                    incrementBtn.disabled = true;
                    await this.plugin._incrementAccumulatedTask(task.file, task.line, task.content);
                    await this.reloadAndRender();
                    incrementBtn.disabled = false;
                });
            } else {
                const checkbox = item.createEl("input", { cls: "habit-tracker-checkbox", attr: { type: "checkbox" } });
                const label = item.createEl("span", { text: formatTaskContent(task.content), cls: "habit-tracker-label" });
                
                // Add streak information for habits (only if enabled)
                let statusBadge: HTMLSpanElement;
                if (this.plugin.settings.enableStreakTracking) {
                    const currentStreak = task.currentStreak || 0;
                    const maxStreak = task.maxStreak || 0;
                    const streakEmoji = getStreakEmoji(currentStreak);
                    statusBadge = item.createSpan({ 
                        cls: "achievement-badge", 
                        text: streakEmoji,
                        title: `Current streak: ${currentStreak} days | Best: ${maxStreak} days`
                    });
                    
                    // Add streak info text
                    if (currentStreak > 0 || maxStreak > 0) {
                        const streakInfo = item.createSpan({ 
                            cls: "achievement-level", 
                            text: `${currentStreak}d (best: ${maxStreak}d)`
                        });
                    }
                } else {
                    // Show simple completion indicator when streaks are disabled
                    statusBadge = item.createSpan({ 
                        cls: "achievement-badge", 
                        text: "📅",
                        title: "Habit tracking enabled (streaks disabled)"
                    });
                }
                
                // Check if task was done today
                const isDoneToday = task.lastDoneDate === getTodayDateStr();
                checkbox.checked = isDoneToday;
                checkbox.disabled = isDoneToday;
                if (isDoneToday) {
                    label.style.textDecoration = "line-through";
                    label.style.opacity = "0.6";
                    // Update to completion badge
                    statusBadge.textContent = "✅";
                }
                checkbox.addEventListener("change", async () => {
                    if (checkbox.checked) {
                        // Check if this is an attribute-based habit
                        if (task.attributeName && this.plugin.settings.dailyNotePath) {
                            await this.plugin._handleAttributeHabitCompletion(task);
                        } else {
                            // Fallback to the original implementation
                            await this.plugin._markHabitTaskDoneWithDate(task.file, task.line, task.content);
                        }

                        checkbox.disabled = true;
                        label.style.textDecoration = "line-through";
                        label.style.opacity = "0.6";
                        statusBadge.textContent = "✅";
                    }
                });
            }
        });
        return section;
    }
}

export default class MyPlugin extends Plugin {
    settings!: MyPluginSettings; // definite assignment assertion

    async activateDailyHabitTrackerView() {
        let leaf = this.app.workspace.getLeavesOfType(DAILY_HABIT_TRACKER_VIEW_TYPE)[0];
        if (!leaf) {
            leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
            await leaf.setViewState({ type: DAILY_HABIT_TRACKER_VIEW_TYPE, active: true });
        }
        this.app.workspace.revealLeaf(leaf);
    }

    async activateEisenhowerMatrixView() {
        let leaf = this.app.workspace.getLeavesOfType(EISENHOWER_MATRIX_VIEW_TYPE)[0];
        if (!leaf) {
            leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
            await leaf.setViewState({ type: EISENHOWER_MATRIX_VIEW_TYPE, active: true });
        }
        this.app.workspace.revealLeaf(leaf);
    }
    async onload() {
        await this.loadSettings();
        this.registerView(
            DAILY_HABIT_TRACKER_VIEW_TYPE,
            (leaf) => new DailyHabitTrackerView(leaf, this)
        );
        this.registerView(
            EISENHOWER_MATRIX_VIEW_TYPE,
            (leaf) => new EisenhowerMatrixView(leaf, this)
        );
        this.addCommand({
            id: "open-daily-habit-tracker-pane",
            name: "Open Daily Habit Tracker (Pane)",
            callback: () => this.activateDailyHabitTrackerView()
        });
        this.addCommand({
            id: "open-eisenhower-matrix-pane",
            name: "Open Eisenhower Matrix (Pane)",
            callback: () => this.activateEisenhowerMatrixView()
        });
        this.addCommand({
            id: "eisenhower-matrix",
            name: "Show Eisenhower Matrix (Legacy Modal)",
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
        // 6. Add new command for habit tracker
        this.addCommand({
            id: "show-habit-tracker",
            name: "Show Daily Habit Tracker",
            callback: () => this.showHabitTracker()
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
        // Remove markdown file creation and writing
        // Show visual modal only
        const html = renderEisenhowerMatrixHTML(groups, this.settings);
        new EisenhowerMatrixModal(this.app, html).open();
    }
    // 7. Implement showHabitTracker
    async showHabitTracker() {
        const files = this.app.vault.getMarkdownFiles();
        let tasks: EisenhowerTask[] = [];
        for (const file of files) {
            const content = await this.app.vault.read(file);
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (/^- \[ \]/.test(line)) {
                    const task = parseTask(line, file.path, i + 1);
                    if (task && task.habitType) {
                        tasks.push(task);
                    }
                }
            }
        }
        const modal = new HabitTrackerModal(this.app, this, tasks);
        modal.onDeleteHabit = async (task) => {
            const file = this.app.vault.getAbstractFileByPath(task.file);
            if (file instanceof TFile) {
                const content = await this.app.vault.read(file);
                const lines = content.split(/\r?\n/);
                lines.splice(task.line - 1, 1); // Remove the task line
                await this.app.vault.modify(file, lines.join("\n"));
                new Notice("Habit deleted!");
                await this.activateDailyHabitTrackerView(); // Refresh the UI
            }
        };
        modal.open();
    }

    async _markHabitTaskDone(filePath: string, lineNumber: number, originalLine: string) {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
            new Notice('Could not find file for habit task.');
            return;
        }
        const content = await this.app.vault.read(file);
        const lines = content.split(/\r?\n/);
        const idx = lineNumber - 1;
        if (lines[idx] && lines[idx].trim() === originalLine.trim()) {
            lines[idx] = lines[idx].replace(/^(- \[) \]/, '$1x]');
            await this.app.vault.modify(file, lines.join("\n"));
            new Notice('Habit marked as complete!');
        } else {
            new Notice('Could not match habit task line.');
        }
    }

    async _incrementAccumulatedTask(filePath: string, lineNumber: number, originalLine: string) {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
            new Notice('Could not find file for accumulated task.');
            return;
        }
        const content = await this.app.vault.read(file);
        const lines = content.split(/\r?\n/);
        const idx = lineNumber - 1;
        let line = lines[idx];
        if (!line) {
            new Notice('Could not match accumulated task line.');
            return;
        }
        // Use prefix up to first property or count for matching
        const originalPrefix = originalLine.split(/(habit::|accumulated::|accumulated-count::|\[\d+]|importance::|urgency::|duration::)/)[0].trim();
        const linePrefix = line.split(/(habit::|accumulated::|accumulated-count::|\[\d+]|importance::|urgency::|duration::)/)[0].trim();
        if (!linePrefix.startsWith(originalPrefix)) {
            new Notice('Could not match accumulated task line.');
            return;
        }
        // Try to update [success::N] property
        if (/\[success::\d+]/i.test(line)) {
            lines[idx] = line.replace(/\[success::(\d+)]/i, (m, n) => `[success::${parseInt(n) + 1}]`);
        } else if (/\[\d+\]\s*$/.test(line)) {
            // Migrate [N] to [success::N+1]
            const match = /\[(\d+)]\s*$/.exec(line);
            const newCount = match ? parseInt(match[1]) + 1 : 1;
            lines[idx] = line.replace(/\[(\d+)]\s*$/, `[success::${newCount}]`);
        } else {
            // If neither, append [success::1]
            lines[idx] = line.trimEnd() + ' [success::1]';
        }
        await this.app.vault.modify(file, lines.join("\n"));
        new Notice('Accumulated task count incremented!');
    }

    async _decrementAccumulatedTask(filePath: string, lineNumber: number, originalLine: string) {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
            new Notice('Could not find file for accumulated task.');
            return;
        }
        const content = await this.app.vault.read(file);
        const lines = content.split(/\r?\n/);
        const idx = lineNumber - 1;
        let line = lines[idx];
        if (!line) {
            new Notice('Could not match accumulated task line.');
            return;
        }
        // Use prefix up to first property or count for matching
        const originalPrefix = originalLine.split(/(habit::|accumulated::|accumulated-count::|\[\d+]|importance::|urgency::|duration::)/)[0].trim();
        const linePrefix = line.split(/(habit::|accumulated::|accumulated-count::|\[\d+]|importance::|urgency::|duration::)/)[0].trim();
        if (!linePrefix.startsWith(originalPrefix)) {
            new Notice('Could not match accumulated task line.');
            return;
        }
        // Decrement [success::N] property
        if (/\[success::\d+]/i.test(line)) {
            lines[idx] = line.replace(/\[success::(\d+)]/i, (m, n) => `[success::${Math.max(0, parseInt(n) - 1)}]`);
        } else if (/\[(\d+)]\s*$/.test(line)) {
            // Migrate [N] to [success::N-1]
            const match = /\[(\d+)]\s*$/.exec(line);
            const newCount = match ? Math.max(0, parseInt(match[1]) - 1) : 0;
            lines[idx] = line.replace(/\[(\d+)]\s*$/, `[success::${newCount}]`);
        } else {
            // If neither, append [success::0]
            lines[idx] = line.trimEnd() + ' [success::0]';
        }
        await this.app.vault.modify(file, lines.join("\n"));
        new Notice('Accumulated task count decremented!');
    }

    async _clearAccumulatedTask(filePath: string, lineNumber: number, originalLine: string) {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
            new Notice('Could not find file for accumulated task.');
            return;
        }
        const content = await this.app.vault.read(file);
        const lines = content.split(/\r?\n/);
        const idx = lineNumber - 1;
        let line = lines[idx];
        if (!line) {
            new Notice('Could not match accumulated task line.');
            return;
        }
        // Use prefix up to first property or count for matching
        const originalPrefix = originalLine.split(/(habit::|accumulated::|accumulated-count::|\[\d+]|importance::|urgency::|duration::)/)[0].trim();
        const linePrefix = line.split(/(habit::|accumulated::|accumulated-count::|\[\d+]|importance::|urgency::|duration::)/)[0].trim();
        if (!linePrefix.startsWith(originalPrefix)) {
            new Notice('Could not match accumulated task line.');
            return;
        }
        // Set [success::0]
        if (/\[success::\d+]/i.test(line)) {
            lines[idx] = line.replace(/\[success::(\d+)]/i, '[success::0]');
        } else if (/\[(\d+)]\s*$/.test(line)) {
            lines[idx] = line.replace(/\[(\d+)]\s*$/, '[success::0]');
        } else {
            lines[idx] = line.trimEnd() + ' [success::0]';
        }
        await this.app.vault.modify(file, lines.join("\n"));
        new Notice('Accumulated task count cleared!');
    }

    async _markHabitTaskDoneWithDate(filePath: string, lineNumber: number, originalLine: string) {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
            new Notice('Could not find file for habit task.');
            return;
        }
        const content = await this.app.vault.read(file);
        const lines = content.split(/\r?\n/);
        const idx = lineNumber - 1;
        if (lines[idx] && lines[idx].trim() === originalLine.trim()) {
            const today = getTodayDateStr();
            
            // Remove any old properties that we'll be updating
            let newLine = lines[idx]
                .replace(/\[last-done::\d{4}-\d{2}-\d{2}\]/g, '')
                .replace(/\[streak::\d+\]/g, '')
                .replace(/\[max-streak::\d+\]/g, '')
                .replace(/\[last-streak-date::\d{4}-\d{2}-\d{2}\]/g, '');
            
            // Add updated last-done property
            newLine = newLine.trimEnd() + ` [last-done::${today}]`;
            
            // Only calculate and update streaks if enabled
            if (this.settings.enableStreakTracking) {
                // Parse current task properties for streak calculation
                const task = parseTask(lines[idx], filePath, lineNumber);
                if (!task) {
                    new Notice('Could not parse task for streak calculation.');
                    return;
                }
                
                // Calculate streak update
                const streakResult = calculateStreakFromDates(
                    task.lastDoneDate,
                    task.lastStreakDate,
                    task.currentStreak || 0
                );
                
                // Update streak if needed
                if (streakResult.shouldUpdate) {
                    const newStreak = streakResult.newStreak;
                    const maxStreak = Math.max(newStreak, task.maxStreak || 0);
                    
                    newLine += ` [streak::${newStreak}]`;
                    newLine += ` [max-streak::${maxStreak}]`;
                    newLine += ` [last-streak-date::${today}]`;
                    
                    const streakEmoji = getStreakEmoji(newStreak);
                    const streakDesc = getStreakDescription(newStreak);
                    
                    lines[idx] = newLine;
                    await this.app.vault.modify(file, lines.join("\n"));
                    new Notice(`Habit completed! ${streakEmoji} ${streakDesc}`);
                } else {
                    lines[idx] = newLine;
                    await this.app.vault.modify(file, lines.join("\n"));
                    new Notice('Habit marked as complete for today!');
                }
            } else {
                // Just add last-done date without streak properties
                lines[idx] = newLine;
                await this.app.vault.modify(file, lines.join("\n"));
                new Notice('Habit marked as complete for today!');
            }
        } else {
            new Notice('Could not match habit task line.');
        }
    }

    public async _handleAttributeHabitCompletion(task: EisenhowerTask) {
        if (!this.settings.dailyNotePath) {
            new Notice("Please set the daily notes path in the plugin settings.");
            return;
        }
        if (!task.attributeName) return;

        try {
            // Step 1: Update the daily note's frontmatter
            await this._updateDailyNoteAttribute(task.attributeName);

            // Step 2: Mark the original task as done for UI/streak consistency
            await this._markHabitTaskDoneWithDate(task.file, task.line, task.content);

        } catch (error) {
            console.error("Failed to handle attribute habit completion:", error);
            new Notice("Error updating daily note. See console for details.");
        }
    }

    private async _updateDailyNoteAttribute(attributeName: string) {
        const today = getTodayDateStr();
        const dailyNotePath = `${this.settings.dailyNotePath}/${today}.md`;
        
        let file = this.app.vault.getAbstractFileByPath(dailyNotePath);
        if (!file || !(file instanceof TFile)) {
            // Create the file with basic frontmatter if it doesn't exist
            file = await this.app.vault.create(dailyNotePath, "---\n---\n\n");
            new Notice(`Created daily note: ${today}.md`);
        }

        if (file instanceof TFile) {
            await this.app.fileManager.processFrontMatter(file, (fm) => {
                fm[attributeName] = (fm[attributeName] || 0) + 1; // Set to 1 or increment
            });
            new Notice(`Updated '${attributeName}' in today's daily note.`);
        }
    }

    async _markEisenhowerTaskDone(filePath: string, lineNumber: number, originalLine: string) {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
            new Notice('Could not find file for task.');
            return;
        }
        const content = await this.app.vault.read(file);
        const lines = content.split(/\r?\n/);
        const idx = lineNumber - 1;
        if (lines[idx] && lines[idx].includes('- [ ]')) {
            // Mark regular Eisenhower task as completed
            lines[idx] = lines[idx].replace('- [ ]', '- [x]');
            await this.app.vault.modify(file, lines.join("\n"));
            new Notice('Task marked as complete!');
            return true;
        } else {
            new Notice('Could not find incomplete task to mark as done.');
            return false;
        }
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

        // --- Habit Tracking Settings Section ---
        containerEl.createEl("h2", { text: "Habit Tracking Settings" });
        new Setting(containerEl)
            .setName("Enable Streak Tracking")
            .setDesc("Track consecutive completion streaks for habit tasks. When disabled, only completion dates are tracked without streak calculations.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableStreakTracking)
                .onChange(async (value) => {
                    this.plugin.settings.enableStreakTracking = value;
                    await this.plugin.saveSettings();
                }));
        
        new Setting(containerEl)
            .setName("Daily notes path")
            .setDesc("The path to the folder where your daily notes are stored for attribute-based habits. Example: 'Journal/Dailies'")
            .addText(text => text
                .setPlaceholder("Path/to/daily/notes")
                .setValue(this.plugin.settings.dailyNotePath)
                .onChange(async (value) => {
                    // Normalize path by removing leading/trailing slashes
                    this.plugin.settings.dailyNotePath = value.replace(/^\/|\/$/g, '');
                    await this.plugin.saveSettings();
                }));
    }
}

// Helper function to improve task display in the habit tracker
function formatTaskContent(content: string): string {
    return content
        .replace(/^- \[.\] /, "") // Remove - [ ] or - [x] at start
        .replace(/\[[^:\[\]]*::[^\[\]]*\]/g, "") // Remove all [property::value] patterns
        .replace(/🔁\s*every day/gi, "") // Remove "🔁 every day"
        .replace(/🔁/g, "") // Remove standalone 🔁
        .replace(/➕\s*\d{4}-\d{2}-\d{2}/g, "") // Remove ➕ YYYY-MM-DD
        .replace(/🛫\s*\d{4}-\d{2}-\d{2}/g, "") // Remove 🛫 YYYY-MM-DD
        .replace(/✅\s*\d{4}-\d{2}-\d{2}/g, "") // Remove ✅ YYYY-MM-DD
        .replace(/⭐|🔥|🔄|🪙/g, "") // Remove other task emojis
        .replace(/⏳\s*\d{4}-\d{2}-\d{2}/g, "") // Remove scheduled dates
        .replace(/⏳\d*/g, "") // Remove duration emojis
        .replace(/\[\d*\]/g, "") // Remove any [] or [number]
        .replace(/\[\s*\]/g, "") // Remove empty []
        .replace(/\s+/g, " ") // Clean up multiple spaces
        .trim();
}

// Motivational color system for habit tracking
function getMotivationalColor(count: number): { background: string; border: string; textColor: string; badge: string } {
    if (count < 0) {
        // Warning gradient for negative values
        if (count >= -2) return { 
            background: "#fff3e0", border: "#ffb74d", textColor: "#e65100", 
            badge: "⚠️" 
        };
        if (count >= -5) return { 
            background: "#ffe0b2", border: "#ff9800", textColor: "#e65100", 
            badge: "⚡" 
        };
        if (count >= -10) return { 
            background: "#ffcc80", border: "#ff9800", textColor: "#d84315", 
            badge: "🚨" 
        };
        return { 
            background: "#ffcdd2", border: "#f44336", textColor: "#c62828", 
            badge: "💥" 
        };
    }
    
    // Achievement gradient for positive values
    if (count <= 2) return { 
        background: "#f5f5f5", border: "#e0e0e0", textColor: "#616161", 
        badge: "🌱" 
    };
    if (count <= 5) return { 
        background: "#e3f2fd", border: "#90caf9", textColor: "#1976d2", 
        badge: "💧" 
    };
    if (count <= 8) return { 
        background: "#bbdefb", border: "#64b5f6", textColor: "#1565c0", 
        badge: "🌊" 
    };
    if (count <= 11) return { 
        background: "#90caf9", border: "#42a5f5", textColor: "#0d47a1", 
        badge: "⚡" 
    };
    if (count <= 15) return { 
        background: "#c8e6c9", border: "#81c784", textColor: "#388e3c", 
        badge: "🌿" 
    };
    if (count <= 20) return { 
        background: "#a5d6a7", border: "#66bb6a", textColor: "#2e7d32", 
        badge: "🍃" 
    };
    if (count <= 30) return { 
        background: "#fff176", border: "#ffeb3b", textColor: "#f57f17", 
        badge: "⭐" 
    };
    return { 
        background: "#ce93d8", border: "#ba68c8", textColor: "#6a1b9a", 
        badge: "👑" 
    };
}

// Get achievement level description
function getAchievementLevel(count: number): string {
    if (count < 0) {
        if (count >= -2) return "Needs Attention";
        if (count >= -5) return "Concerning";
        if (count >= -10) return "Warning";
        return "Critical";
    }
    
    if (count <= 2) return "Starting Out";
    if (count <= 5) return "Building Momentum";
    if (count <= 8) return "Getting Consistent";
    if (count <= 11) return "Strong Habit";
    if (count <= 15) return "Habit Established";
    if (count <= 20) return "Mastery Building";
    if (count <= 30) return "Golden Streak";
    return "Legend Status";
}

// 5. Add Habit Tracker Modal (with direct event handling)
class HabitTrackerModal extends Modal {
    plugin: MyPlugin;
    habitTasks: (EisenhowerTask & { type: "daily" | "weekly" })[];

    // New property for delete handler
    onDeleteHabit?: (task: EisenhowerTask) => Promise<void>;

    constructor(app: App, plugin: MyPlugin, habitTasks: EisenhowerTask[]) {
        super(app);
        this.plugin = plugin;
        // Pre-process tasks into a more manageable format
        this.habitTasks = habitTasks.map(task => ({
            ...task,
            type: task.habitType || "daily"
        }));
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        
        // Create header
        contentEl.createEl("h2", { text: "Daily Habit Tracker" });
        
        // Create container elements
        const container = contentEl.createDiv({ cls: "habit-tracker-container" });
        
        // Add styling
        const styleEl = document.createElement("style");
        styleEl.textContent = `
            .habit-tracker-section { margin-bottom: 24px; }
            .habit-tracker-title { font-weight: bold; font-size: 1.1em; margin-bottom: 8px; }
            .habit-tracker-list { list-style: none; padding: 0; }
            .habit-tracker-item { margin-bottom: 6px; padding: 6px 0; border-bottom: 1px solid #eee; display: flex; align-items: center; }
            .habit-tracker-checkbox { margin-right: 10px; }
            .habit-tracker-label { flex: 1; }
            .accumulated-btn { border: 1px solid #bbb; border-radius: 6px; padding: 4px 10px; cursor: pointer; display: flex; align-items: center; margin-left: 2px; margin-right: 2px; font-weight: bold; }
            .accumulated-btn:active { filter: brightness(0.95); }
            .accumulated-btn.plus { background: #e6ffe6; color: #218838; border-color: #b2e6b2; }
            .accumulated-btn.minus { background: #ffe6e6; color: #c82333; border-color: #e6b2b2; }
            .accumulated-btn.clear { background: #e6f0ff; color: #005cbf; border-color: #b2cbe6; }
            .count-badge { background: #e0e0e0; color: #333; border-radius: 10px; padding: 2px 8px; margin-left: 8px; font-weight: bold; }
        `;
        container.appendChild(styleEl);
        
        // Create Daily Habits section
        this.createHabitSection(
            container, 
            "🔄 Daily Habits", 
            this.habitTasks.filter(t => t.type === "daily")
        );
        // Create Weekly Habits section
        this.createHabitSection(
            container, 
            "🔁 Weekly Habits", 
            this.habitTasks.filter(t => t.type === "weekly")
        );
    }

    createHabitSection(container: HTMLElement, title: string, tasks: (EisenhowerTask & { type: "daily" | "weekly" })[]) {
        const section = container.createDiv({ cls: "habit-tracker-section" });
        section.createDiv({ text: title, cls: "habit-tracker-title" });
        const list = section.createEl("ul", { cls: "habit-tracker-list" });
        if (tasks.length === 0) {
            list.createEl("li", { text: `No ${title.toLowerCase().includes("daily") ? "daily" : "weekly"} habits found`, attr: { style: "color:#aaa;" } });
            return section;
        }
        tasks.forEach(task => {
            const item = list.createEl("li", { cls: "habit-tracker-item" });
            // Add click handler to open file and focus line
            item.addEventListener("click", (e) => {
                if ((e.target as HTMLElement).tagName === "BUTTON" || (e.target as HTMLElement).tagName === "INPUT") return;
                const file = this.plugin.app.vault.getAbstractFileByPath(task.file);
                if (file instanceof TFile) {
                    this.plugin.app.workspace.openLinkText(task.file, '', false).then(() => {
                        const leaf = this.plugin.app.workspace.getMostRecentLeaf();
                        if (leaf && leaf.view instanceof MarkdownView) {
                            const editor = leaf.view.editor;
                            if (editor) {
                                editor.setCursor({ line: task.line - 1, ch: 0 });
                            }
                        }
                    });
                }
            });
            if (task.accumulated) {
                const btn = item.createEl("button", { cls: "accumulated-btn" });
                btn.createSpan({ text: formatTaskContent(task.content) });
                const badge = btn.createSpan({ cls: "count-badge", text: String(task.accumulatedCount ?? 0) });
                btn.addEventListener("click", async () => {
                    btn.disabled = true;
                    await this.plugin._incrementAccumulatedTask(task.file, task.line, task.content);
                    // Re-read the updated line from the file to get the new count
                    const file = this.plugin.app.vault.getAbstractFileByPath(task.file);
                    if (file instanceof TFile) {
                        const content = await this.plugin.app.vault.read(file);
                        const lines = content.split(/\r?\n/);
                        const updatedLine = lines[task.line - 1];
                        // Parse the updated line for the new count
                        let newCount = 0;
                        const successMatch = /\[success::(\d+)]/i.exec(updatedLine);
                        if (successMatch) newCount = parseInt(successMatch[1]);
                        else {
                            const bracketCount = /\[(\d+)]\s*$/.exec(updatedLine);
                            if (bracketCount) newCount = parseInt(bracketCount[1]);
                        }
                        badge.setText(String(newCount));
                    }
                    btn.disabled = false;
                });
            } else {
                const checkbox = item.createEl("input", { cls: "habit-tracker-checkbox", attr: { type: "checkbox" } });
                const label = item.createEl("span", { text: formatTaskContent(task.content), cls: "habit-tracker-label" });
                // Check if task was done today
                const isDoneToday = task.lastDoneDate === getTodayDateStr();
                checkbox.checked = isDoneToday;
                checkbox.disabled = isDoneToday;
                if (isDoneToday) {
                    label.style.textDecoration = "line-through";
                    label.style.opacity = "0.6";
                }
                checkbox.addEventListener("change", async () => {
                    if (checkbox.checked) {
                        await this.plugin._markHabitTaskDoneWithDate(task.file, task.line, task.content);
                        checkbox.disabled = true;
                        label.style.textDecoration = "line-through";
                        label.style.opacity = "0.6";
                    }
                });
            }
            // Add delete button for each task
            const deleteBtn = item.createEl("button", { text: "Delete Habit", cls: "delete-habit-btn" });
            deleteBtn.addEventListener("click", async (e) => {
                e.stopPropagation(); // Prevent triggering the item click
                if (this.onDeleteHabit) {
                    await this.onDeleteHabit(task);
                }
            });
            item.appendChild(deleteBtn);
        });
        return section;
    }
}

// Helper to get today's date as YYYY-MM-DD
function getTodayDateStr(): string {
    const d = new Date();
    return d.toISOString().slice(0, 10);
}

// Helper to get yesterday's date as YYYY-MM-DD
function getYesterdayDateStr(): string {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
}

// Streak calculation functions for Option A implementation
function calculateStreakFromDates(lastDoneDate: string | undefined, lastStreakDate: string | undefined, currentStreak: number = 0): { newStreak: number; shouldUpdate: boolean } {
    const today = getTodayDateStr();
    const yesterday = getYesterdayDateStr();
    
    // If never done before, start fresh
    if (!lastDoneDate) {
        return { newStreak: 0, shouldUpdate: false };
    }
    
    // If done today and streak already updated today, no change
    if (lastDoneDate === today && lastStreakDate === today) {
        return { newStreak: currentStreak, shouldUpdate: false };
    }
    
    // If done today but streak not updated yet
    if (lastDoneDate === today) {
        // Check if we did it yesterday to continue streak
        if (lastStreakDate === yesterday) {
            return { newStreak: currentStreak + 1, shouldUpdate: true };
        } else {
            // Starting new streak
            return { newStreak: 1, shouldUpdate: true };
        }
    }
    
    // If not done today, check if streak should be reset
    if (lastDoneDate === yesterday && lastStreakDate === yesterday) {
        // Streak was valid yesterday, but not done today - maintain for now
        return { newStreak: currentStreak, shouldUpdate: false };
    }
    
    // If last done was before yesterday, reset streak
    return { newStreak: 0, shouldUpdate: true };
}

function calculateAccumulatedStreak(accumulatedCount: number, lastStreakDate: string | undefined): { streak: number; shouldUpdate: boolean } {
    const today = getTodayDateStr();
    const yesterday = getYesterdayDateStr();
    
    // For accumulated tasks, streak is based on daily completion pattern
    // If we haven't updated streak today and we have completions, increment
    if (lastStreakDate !== today && accumulatedCount > 0) {
        // Check if we had activity yesterday to continue streak
        if (lastStreakDate === yesterday) {
            return { streak: 1, shouldUpdate: true }; // Continue streak concept
        } else {
            return { streak: 1, shouldUpdate: true }; // New activity
        }
    }
    
    return { streak: 0, shouldUpdate: false };
}

function getStreakEmoji(streak: number): string {
    if (streak === 0) return "🌱";
    if (streak <= 3) return "🔥";
    if (streak <= 7) return "⚡";
    if (streak <= 14) return "🌟";
    if (streak <= 30) return "💎";
    if (streak <= 60) return "👑";
    return "🏆";
}

function getStreakDescription(streak: number): string {
    if (streak === 0) return "Starting fresh";
    if (streak === 1) return "Day 1";
    if (streak <= 3) return `${streak} day streak`;
    if (streak <= 7) return `${streak} day streak - Great!`;
    if (streak <= 14) return `${streak} day streak - Amazing!`;
    if (streak <= 30) return `${streak} day streak - Incredible!`;
    if (streak <= 60) return `${streak} day streak - Legendary!`;
    return `${streak} day streak - Godlike!`;
}
