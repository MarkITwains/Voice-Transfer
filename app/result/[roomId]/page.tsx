import { notFound, redirect } from "next/navigation";
import { getServerUser } from "@/app/lib/auth";
import { getMeeting } from "@/app/lib/meetingRepo";
import ResultClient from "@/app/components/ResultClient";

// 数据来自 DB 且依赖登录身份，必须每次请求时取数
export const dynamic = "force-dynamic";

export default async function ResultPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;

  // Server Component 自行鉴权（纵深防御：不依赖 proxy）
  const user = await getServerUser();
  if (!user) {
    redirect("/login");
  }

  // 按用户隔离取数：他人会议与不存在会议统一真 404（不暴露存在性，验收标准 3）
  const data = await getMeeting(user.id, roomId);

  if (!data) {
    notFound();
  }

  return <ResultClient roomId={roomId} initialData={data} />;
}