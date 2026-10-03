"use client";

import { useState } from "react";
import { saveAs } from "file-saver";
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";
import type { Todo } from "@/app/lib/types";

interface Props {
    title: string;
    summary: string;
    keyDecisions?: string[];
    todos: Todo[];
    transcript?: string;
    type?: string;
    createdAt?: string;
}

export default function ModernExportWord({
    title,
    summary,
    keyDecisions = [],
    todos = [],
    transcript,
    type = "日常例会",
    createdAt,
}: Props) {
    const [exporting, setExporting] = useState(false);

    async function handleExport() {
        try {
            setExporting(true);

            const docChildren: Paragraph[] = [
                new Paragraph({
                    heading: HeadingLevel.TITLE,
                    children: [new TextRun({ text: title || "会议纪要", bold: true, size: 36 })],
                }),
                new Paragraph({
                    children: [
                        new TextRun({
                            text: `会议类型：${type}    整理时间：${createdAt ? new Date(createdAt).toLocaleString("zh-CN") : new Date().toLocaleString("zh-CN")}`,
                            color: "666666",
                            size: 20,
                        }),
                    ],
                }),
                new Paragraph(""),
            ];

            // 章节序号动态推进（一、二、三…）：条件章节缺失时编号不跳号
            const CN_NUM = ["一", "二", "三", "四", "五", "六"];
            let secIndex = 0;
            const sectionHeading = (label: string) =>
                new Paragraph({
                    heading: HeadingLevel.HEADING_1,
                    children: [new TextRun({ text: `${CN_NUM[secIndex++] ?? ""}、${label}`, bold: true })],
                });

            // 核心决议：与结果页一致按「；」分条展示，而非堆成一段
            const summaryItems = (summary || "")
                .split("；")
                .map((s) => s.trim())
                .filter(Boolean);
            docChildren.push(sectionHeading("核心结论与决议"));
            if (summaryItems.length > 0) {
                docChildren.push(
                    ...summaryItems.map((s, i) => new Paragraph({ text: `${i + 1}. ${s}` }))
                );
            } else {
                docChildren.push(new Paragraph("暂无核心决议"));
            }
            docChildren.push(new Paragraph(""));

            // 明确决策事项（条件章节）
            if (keyDecisions.length > 0) {
                docChildren.push(sectionHeading("明确决策事项"));
                docChildren.push(
                    ...keyDecisions.map((item, i) => new Paragraph({ text: `${i + 1}. ${item}` }))
                );
                docChildren.push(new Paragraph(""));
            }

            // 待办任务追踪
            docChildren.push(sectionHeading("待办任务追踪"));
            docChildren.push(
                ...(todos.length > 0
                    ? todos.map(
                          (t) =>
                              new Paragraph({
                                  text: `${t.completed ? "[已完成]" : "[待推进]"} ${t.content}${
                                      t.assignee ? ` （负责人：${t.assignee}）` : ""
                                  }${t.deadline ? ` （截止：${t.deadline}）` : ""}`,
                              })
                      )
                    : [new Paragraph("暂无待办事项")])
            );
            docChildren.push(new Paragraph(""));

            // 原始讨论发言记录（条件章节）
            if (transcript) {
                docChildren.push(sectionHeading("原始讨论发言记录"));
                docChildren.push(new Paragraph(transcript));
            }

            const doc = new Document({
                sections: [
                    {
                        children: docChildren,
                    },
                ],
            });

            const blob = await Packer.toBlob(doc);
            saveAs(blob, `${(title || "会议纪要").replace(/[/\\?%*:|"<>]/g, "_")}.docx`);
        } catch (err) {
            console.error("导出 Word 失败:", err);
            alert("导出 Word 失败，请稍后重试");
        } finally {
            setExporting(false);
        }
    }

    return (
        <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="px-3 py-1.5 text-xs font-medium text-stone-700 bg-white hover:bg-stone-100 border border-stone-200 rounded-[2px] shadow-2xs transition-colors flex items-center gap-1.5 disabled:opacity-50"
        >
            <svg className="w-3.5 h-3.5 text-stone-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            <span>{exporting ? "导出中..." : "导出 Word"}</span>
        </button>
    );
}
