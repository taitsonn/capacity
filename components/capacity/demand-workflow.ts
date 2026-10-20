import type { DemandStatus } from "@/lib/types";
export type DemandAction = "confirm" | "reserve" | "save";
export const isReservation = (status: DemandStatus) => status === "requested" || status === "planning";
/** Confirmation is always an explicit submit intent; assigning people alone is a reservation. */
export function statusForDemandAction(status: DemandStatus, action: DemandAction): DemandStatus {
  if (action === "confirm") return "confirmed";
  if (action === "reserve") return isReservation(status) ? status : "planning";
  return status;
}
