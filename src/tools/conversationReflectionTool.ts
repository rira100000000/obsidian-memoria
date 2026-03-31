// src/tools/conversationReflectionTool.ts
import { StructuredTool } from "@langchain/core/tools";
import { BaseMessage } from "@langchain/core/messages";
import { ReflectionEngine, ConversationMessage } from '../core/reflectionEngine';
import { z } from "zod";

const ConversationReflectionToolSchema = z.object({
    conversationHistory: z.array(z.object({
        type: z.string().describe("Type of the message (e.g., 'human', 'ai', 'system', 'tool')"),
        content: z.string().describe("Content of the message")
    })).describe("The history of the conversation, including user, AI, and potentially tool messages."),
    llmRoleName: z.string().describe("The role name of the LLM persona making the reflection."),
    fullLogFileName: z.string().describe("The filename of the full conversation log (e.g., 'YYYYMMDDHHmmss.md') that this reflection is based on.")
});

export type ConversationReflectionToolInput = z.infer<typeof ConversationReflectionToolSchema>;

export class ConversationReflectionTool extends StructuredTool<typeof ConversationReflectionToolSchema> {
    schema = ConversationReflectionToolSchema;

    name = "conversation_reflection_and_summary_tool";
    description = `Analyzes the current conversation from the LLM's perspective and writes a summary note.
Input should be an object with 'conversationHistory' (array of messages with 'type' and 'content'), 'llmRoleName' (string), and 'fullLogFileName' (string).
Use this tool when the conversation seems to be concluding, when a natural point for reflection is reached, or when explicitly asked by the user to summarize or reflect on the conversation.
This tool helps in consolidating learnings and key points from the dialogue into a structured note.`;

    private engine: ReflectionEngine;
    private lastCreatedFilePath: string | null = null;

    constructor(engine: ReflectionEngine) {
        super();
        this.engine = engine;
    }

    public getLastCreatedFilePath(): string | null {
        return this.lastCreatedFilePath;
    }

    public clearLastCreatedFile(): void {
        this.lastCreatedFilePath = null;
    }

    protected async _call(input: ConversationReflectionToolInput): Promise<string> {
        const messages: ConversationMessage[] = input.conversationHistory.map(msg => ({
            role: (msg.type === 'human' ? 'human' : msg.type === 'ai' ? 'ai' : msg.type === 'system' ? 'system' : 'tool') as ConversationMessage['role'],
            content: msg.content,
        }));

        const result = await this.engine.generateReflection({
            messages,
            llmRoleName: input.llmRoleName,
            fullLogFileName: input.fullLogFileName,
        });

        if (result.success) {
            this.lastCreatedFilePath = result.filePath;
            return `振り返りノートを作成しました: ${result.baseName} (${result.filePath})`;
        } else {
            return result.error || "エラー: 振り返りの生成に失敗しました。";
        }
    }

    public async generateAndSaveReflection(history: BaseMessage[], roleName: string, logFileName: string): Promise<string> {
        this.lastCreatedFilePath = null;
        const messages: ConversationMessage[] = history.map(msg => {
            let content: string;
            if (typeof msg.content === 'string') {
                content = msg.content;
            } else if (Array.isArray(msg.content)) {
                content = msg.content.map(c => typeof c === 'string' ? c : (c as any)?.text || '').join('');
            } else {
                content = String(msg.content || '');
            }
            return {
                role: (msg._getType() === 'human' ? 'human' : msg._getType() === 'ai' ? 'ai' : 'system') as ConversationMessage['role'],
                content,
            };
        });

        const result = await this.engine.generateReflection({ messages, llmRoleName: roleName, fullLogFileName: logFileName });

        if (result.success) {
            this.lastCreatedFilePath = result.filePath;
            return result.filePath;
        }
        return result.error || "エラー: 振り返りの生成に失敗しました。";
    }
}
