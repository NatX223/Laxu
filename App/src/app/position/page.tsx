import { redirect } from "next/navigation";

/** The bare route was the design's "Lunar Ladder" demo; real positions live at /position/[address]. */
export default function PositionPage() {
  redirect("/trade");
}
