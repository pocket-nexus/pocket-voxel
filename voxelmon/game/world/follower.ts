import type { Dir } from "./collision.ts";
import type { Player } from "./player.ts";

/** Cosmetic, non-colliding companion. Interpolate along the player's last
 * traversed cell, so corners follow the path instead of cutting through walls. */
export class PartyFollower {
  species = "";
  active = false;
  px = 0;
  py = 0;
  frame = 0;
  facing: Dir = "down";
  private lastX = 0;
  private lastY = 0;
  private startX = 0;
  private startY = 0;
  private hasTrail = false;

  reset(player: Player): void {
    this.facing = player.facing;
    this.frame = 0;
    this.lastX = this.startX = player.cellX;
    this.lastY = this.startY = player.cellY;
    this.px = player.px; this.py = player.py;
    this.active = this.hasTrail = false;
  }

  update(player: Player, lead?: { species?: string }): void {
    this.species = lead?.species ?? "";
    if (player.cellX !== this.lastX || player.cellY !== this.lastY) {
      this.startX = this.lastX; this.startY = this.lastY;
      this.lastX = player.cellX; this.lastY = player.cellY;
      this.hasTrail = true;
    }
    const t = player.moving ? Math.min(1, player.progress / Math.max(1, player.stepFramesCur ?? player.stepFrames)) : 0;
    const dx = player.cellX - this.startX, dy = player.cellY - this.startY;
    if (dx || dy) this.facing = dx > 0 ? "right" : dx < 0 ? "left" : dy < 0 ? "up" : "down";
    this.px = (this.startX + (player.cellX - this.startX) * t) * 16;
    this.py = (this.startY + (player.cellY - this.startY) * t) * 16;
    this.active = !!this.species && this.hasTrail && !player.surfing &&
      Math.abs(this.px - player.px) + Math.abs(this.py - player.py) >= 8;
    const pose = (player.moving || player.stepLanded) && player.walkPhase() === 1 ? 3 : 0;
    this.frame = (this.facing === "down" ? 0 : this.facing === "up" ? 1 : 2) + pose;
  }
}
