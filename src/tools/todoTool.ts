// src/tools/todoTool.ts
import { StructuredTool } from "@langchain/core/tools";
import { App, TFile, Notice, normalizePath } from 'obsidian';
import ObsidianMemoria from "../../main";
import { GeminiPluginSettings } from "../settings";
import { z } from "zod";

// Zodスキーマの定義
const TodoActionParamsSchema = z.object({
    task: z.string().optional().describe("The description of the task."),
    dueDate: z.string().optional().describe("The due date of the task in YYYY-MM-DD format."),
    priority: z.enum(["high", "medium", "low"]).optional().describe("The priority of the task."),
    task_description: z.string().optional().describe("Alias for task, used for completing or deleting specific tasks by their exact description.")
}).describe("Parameters for the TODO action.");

const TodoToolInputSchema = z.object({
    action: z.enum(["get_todos", "add_todo", "complete_todo", "delete_todo"])
             .describe("The action to perform on the TODO list."),
    parameters: TodoActionParamsSchema.optional()
}).describe("Input for the TodoTool, specifying an action and its parameters.");

// Toolの入力型をZodスキーマから推論
export type TodoToolInput = z.infer<typeof TodoToolInputSchema>;
export type TodoActionParams = z.infer<typeof TodoActionParamsSchema>;

export interface TodoItem {
  task: string;
  completed: boolean;
  dueDate?: string;
  priority?: string;
  raw: string;
}

const TODO_ITEM_REGEX = /^- \[( |x)\] (.*)/;

// Toolクラスの型パラメータにスキーマの型を指定
export class TodoTool extends StructuredTool<typeof TodoToolInputSchema> {
    schema = TodoToolInputSchema;

    name = "todo_manager";
    description = `Manages a TODO list stored in a Markdown file within Obsidian.
    Input must be an object specifying the "action" and optional "parameters".
    Available actions:
    - "get_todos": Retrieves all current TODO items. No parameters needed. Returns a list of tasks.
    - "add_todo": Adds a new task. Parameters: {"task": "description of the new task", "dueDate"?: "YYYY-MM-DD", "priority"?: "high|medium|low"}.
    - "complete_todo": Marks an existing task as complete. Parameters: {"task_description": "exact description of the task to complete"}.
    - "delete_todo": Deletes an existing task. Parameters: {"task_description": "exact description of the task to delete"}.
    All actions return a JSON string indicating success or failure, and "get_todos" includes the list of TODO items in its 'data' field.`;

    private app: App;
    private plugin: ObsidianMemoria;
    private settings: GeminiPluginSettings;

    constructor(plugin: ObsidianMemoria) {
        super();
        this.plugin = plugin;
        this.app = plugin.app;
        this.settings = plugin.settings;
    }

    public onSettingsChanged(): void {
        this.settings = this.plugin.settings;
    }

    private getTodoFilePath(): string {
        return normalizePath(this.settings.todoFileName || "TODOs.md");
    }

    private async ensureTodoFileExists(): Promise<TFile> {
        const filePath = this.getTodoFilePath();
        let file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file || !(file instanceof TFile)) {
            const content = `# TODOs\n\n`;
            try {
                file = await this.app.vault.create(filePath, content);
                new Notice(`TODO file created at ${filePath}`);
            } catch (e) {
                console.error(`Error creating TODO file at ${filePath}:`, e);
                new Notice(`Failed to create TODO file: ${filePath}`);
                throw e;
            }
        }
        return file as TFile;
    }

    private parseTodoLine(line: string): TodoItem | null {
        const match = line.match(TODO_ITEM_REGEX);
        if (match) {
            const completed = match[1] === 'x';
            let task = match[2].trim();
            let dueDate: string | undefined;
            let priority: string | undefined;

            const dueDateMatch = task.match(/\(due: ([\d-]+)\)/);
            if (dueDateMatch) {
                dueDate = dueDateMatch[1];
                task = task.replace(dueDateMatch[0], '').trim();
            }

            const priorityMatch = task.match(/\(priority: (high|medium|low)\)/i);
            if (priorityMatch) {
                priority = priorityMatch[1].toLowerCase();
                task = task.replace(priorityMatch[0], '').trim();
            }

            return { task, completed, dueDate, priority, raw: line };
        }
        return null;
    }

    private formatTodoLine(task: string, completed: boolean, dueDate?: string, priority?: string): string {
        let line = `- [${completed ? 'x' : ' '}] ${task}`;
        if (dueDate) line += ` (due: ${dueDate})`;
        if (priority) line += ` (priority: ${priority})`;
        return line;
    }

    private async getTodos(): Promise<TodoItem[]> {
        const file = await this.ensureTodoFileExists();
        const content = await this.app.vault.read(file);
        const lines = content.split('\n');
        const todos: TodoItem[] = [];
        for (const line of lines) {
            const todo = this.parseTodoLine(line);
            if (todo) {
                todos.push(todo);
            }
        }
        return todos;
    }

    private async addTodo(params: TodoActionParams): Promise<{ success: boolean; message: string }> {
        if (!params.task || params.task.trim() === "") {
            return { success: false, message: "Task description cannot be empty." };
        }
        const task = params.task.trim();
        const dueDate = params.dueDate;
        const priority = params.priority;

        const file = await this.ensureTodoFileExists();
        const newLine = this.formatTodoLine(task, false, dueDate, priority);

        try {
            await this.app.vault.append(file, `\n${newLine}`);
            return { success: true, message: `Task "${task}" added.` };
        } catch (e) {
            console.error("Error adding TODO:", e);
            return { success: false, message: "Failed to add task to file." };
        }
    }
    
    private async findAndModifyTodo(
        taskDescription: string,
        modifyFn: (todo: TodoItem, index: number, lines: string[]) => { modified: boolean, newLine?: string, remove?: boolean, message?: string }
    ): Promise<{ success: boolean; message: string }> {
        if (!taskDescription || taskDescription.trim() === "") {
            return { success: false, message: "Task description for modification cannot be empty." };
        }
        const targetTaskDesc = taskDescription.trim();
        const file = await this.ensureTodoFileExists();
        let content = await this.app.vault.read(file);
        const lines = content.split('\n');
        let foundAndModified = false;
        let resultMessage = `Task "${targetTaskDesc}" not found or no action taken.`;

        for (let i = 0; i < lines.length; i++) {
            const todo = this.parseTodoLine(lines[i]);
            if (todo && todo.task === targetTaskDesc) {
                const result = modifyFn(todo, i, lines);
                if (result.modified) {
                    if (result.remove) {
                        lines.splice(i, 1);
                        i--; 
                    } else if (result.newLine !== undefined) {
                        lines[i] = result.newLine;
                    }
                    resultMessage = result.message || `Task "${targetTaskDesc}" was successfully modified.`;
                    foundAndModified = true;
                } else {
                    resultMessage = result.message || `Task "${targetTaskDesc}" found but no modification was made (e.g., already completed).`;
                }
                break; 
            }
        }

        if (!foundAndModified) {
            if (!lines.some(line => this.parseTodoLine(line)?.task === targetTaskDesc)) {
                resultMessage = `Task "${targetTaskDesc}" not found.`;
            }
            return { success: false, message: resultMessage };
        }

        content = lines.join('\n');
        try {
            await this.app.vault.modify(file, content);
            return { success: true, message: resultMessage };
        } catch (e) {
            console.error("Error modifying TODO file:", e);
            return { success: false, message: "Failed to update TODO file." };
        }
    }

    private async completeTodo(params: TodoActionParams): Promise<{ success: boolean; message: string }> {
        const taskDesc = params.task_description || params.task;
        if (!taskDesc) return { success: false, message: "Task description not provided for completion." };

        return this.findAndModifyTodo(taskDesc, (todo, index, lines) => {
            if (todo.completed) {
                return { modified: false, message: `Task "${taskDesc}" is already completed.` };
            }
            const newLine = this.formatTodoLine(todo.task, true, todo.dueDate, todo.priority);
            return { modified: true, newLine, message: `Task "${taskDesc}" marked as complete.` };
        });
    }

    private async deleteTodo(params: TodoActionParams): Promise<{ success: boolean; message: string }> {
        const taskDesc = params.task_description || params.task;
        if (!taskDesc) return { success: false, message: "Task description not provided for deletion." };

        return this.findAndModifyTodo(taskDesc, (todo, index, lines) => {
            return { modified: true, remove: true, message: `Task "${taskDesc}" deleted.` };
        });
    }

    protected async _call(input: TodoToolInput): Promise<string> {
        if (!input.action) {
            return JSON.stringify({ success: false, message: "No action specified in TodoTool input." });
        }

        const params = input.parameters || {};

        try {
            switch (input.action) {
                case "get_todos": { // ★ 波括弧でスコープを作成
                    const todos = await this.getTodos();
                    return JSON.stringify({ success: true, message: "TODOs retrieved successfully.", data: todos });
                }
                case "add_todo": { // ★ 波括弧でスコープを作成
                    const addResult = await this.addTodo(params);
                    return JSON.stringify(addResult);
                }
                case "complete_todo": { // ★ 波括弧でスコープを作成
                    const completeResult = await this.completeTodo(params);
                    return JSON.stringify(completeResult);
                }
                case "delete_todo": { // ★ 波括弧でスコープを作成
                    const deleteResult = await this.deleteTodo(params);
                    return JSON.stringify(deleteResult);
                }
                default: { // ★ defaultケースも波括弧で囲む (必須ではないが統一性のため)
                    // This case should not be reachable if Zod validation is working correctly with the enum
                    const exhaustiveCheck: never = input.action;
                    return JSON.stringify({ success: false, message: `Unknown action: ${exhaustiveCheck}` });
                }
            }
        } catch (error: any) {
            console.error(`[TodoTool] Error during action "${input.action}":`, error);
            return JSON.stringify({ success: false, message: `Error executing ${input.action}: ${error.message}` });
        }
    }
}
