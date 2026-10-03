/**
 * 会议领域类型定义（唯一归属）
 *
 * 自原 app/store.ts 迁出。前后端统一从此文件 import，
 * 禁止再从 @/app/store 引用（该文件已删除）。
 */

/** 脑图节点（一层树结构） */
export interface MindMapNode {
    title: string;
    children?: string[];
}

/** 待办事项 */
export interface Todo {
    id?: string;
    content: string;
    assignee?: string;
    deadline?: string;
    completed?: boolean;
}

/**
 * 会议纪要数据（对外契约）
 *
 * createdAt 恒为 ISO 8601 字符串：DB 内为 TIMESTAMPTZ，
 * 由 meetingRepo 统一转换为 toISOString() 输出，前端零改动。
 */
export interface MeetingData {
    id?: string;
    title: string;
    style?: string;
    type?: string;
    summary: string;
    keyDecisions?: string[];
    risks?: string[];
    mindmap?: MindMapNode[];
    todos: Todo[];
    transcript?: string;
    audioUrl?: string;
    duration?: string;
    createdAt: string;
    wordCount?: number;
}
