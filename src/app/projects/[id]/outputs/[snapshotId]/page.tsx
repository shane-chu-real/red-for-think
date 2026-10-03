import { OutputView } from "@/components/OutputView";

export default async function OutputPage({ params }: { params: Promise<{ id: string; snapshotId: string }> }) {
  const { id, snapshotId } = await params;
  return <OutputView projectId={id} snapshotId={snapshotId} />;
}
