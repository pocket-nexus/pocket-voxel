/** Match the shared 640 x 960 control artwork, fitted inside the app viewport. */
export function touchButtons(touches: readonly number[], width: number, height: number): number {
  const scale = Math.min(width / 640, height / 960);
  if (!(scale > 0)) return 0;
  const left = (width - 640 * scale) / 2, top = (height - 960 * scale) / 2;
  let buttons = 0;
  for (const packed of touches) {
    const wide = (packed >>> 31) !== 0;
    const x = (((wide ? packed & 1023 : packed & 511) - left) / scale) / 2;
    const y = (((wide ? packed >>> 10 & 1023 : packed >>> 9 & 511) - top) / scale) / 2;
    if (y < 240 || y > 480) continue;
    const dx = x - 75, dy = y - 350;
    if ((Math.abs(dx) <= 23 && Math.abs(dy) <= 65) || (Math.abs(dy) <= 23 && Math.abs(dx) <= 65)) {
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 12) buttons |= dx < 0 ? 4 : 8;
      else if (Math.abs(dy) > 12) buttons |= dy < 0 ? 1 : 2;
    }
    if ((x - 260) ** 2 + (y - 320) ** 2 <= 42 ** 2) buttons |= 16;
    if ((x - 202) ** 2 + (y - 375) ** 2 <= 40 ** 2) buttons |= 32;
    if (x >= 98 && x <= 144 && y >= 448 && y <= 474) buttons |= 128;
    if (x >= 169 && x <= 215 && y >= 448 && y <= 474) buttons |= 64;
  }
  return buttons;
}

/** One contact owns the About menu through release; gameplay remains multitouch. */
export class Controls {
  menu = false;
  private owner = -1;
  private x = 0;
  private y = 0;
  private menuPressed = false;
  private donePressed = false;
  private consumed = false;

  sample(touches: readonly number[], width: number, height: number, keys = 0) {
    const scale = Math.min(width / 320, height / 480);
    const contacts = touches.map(packed => {
      const wide = (packed >>> 31) !== 0;
      return {
        id: wide ? packed >>> 20 & 255 : packed >>> 18 & 255,
        x: ((wide ? packed & 1023 : packed & 511) - (width - 320 * scale) / 2) / scale,
        y: ((wide ? packed >>> 10 & 1023 : packed >>> 9 & 511) - (height - 480 * scale) / 2) / scale,
      };
    });
    const inside = (x: number, y: number, l: number, t: number, r: number, b: number) => x >= l && x <= r && y >= t && y <= b;
    const menuHit = (x: number, y: number) => inside(x, y, 137, 250, 183, 273);
    const doneHit = (x: number, y: number) => inside(x, y, 122, 305, 198, 333);
    let contact = contacts.find(c => c.id === this.owner);
    if (this.owner >= 0 && !contact) {
      if (this.donePressed && doneHit(this.x, this.y)) this.menu = false;
      else if (this.menuPressed && menuHit(this.x, this.y)) this.menu = !this.menu;
      this.owner = -1; this.menuPressed = this.donePressed = this.consumed = false;
    }
    if (this.owner < 0 && contacts.length) {
      contact = contacts[0]; this.owner = contact.id;
      if (this.menu) {
        this.consumed = true;
        if (doneHit(contact.x, contact.y)) this.donePressed = true;
        else if (menuHit(contact.x, contact.y)) this.menuPressed = true;
        else if (!inside(contact.x, contact.y, 36, 92, 284, 352)) this.menu = false;
      } else if (menuHit(contact.x, contact.y)) this.menuPressed = this.consumed = true;
    }
    if (contact) { this.x = contact.x; this.y = contact.y; }
    const buttons = this.menu || this.consumed ? 0 : keys | touchButtons(touches, width, height);
    return { buttons, visual: (buttons | (this.menu ? 0x80000000 : 0) | (this.menuPressed ? 0x40000000 : 0) | (this.donePressed ? 0x20000000 : 0)) >>> 0 };
  }
}
