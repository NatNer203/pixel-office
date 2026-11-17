import Phaser from "phaser";
import type { OfficeRequest } from "./types";

export type RequestData = OfficeRequest;

type GameCallbacks = {
  onOpenCentralDesk: () => void;
  onOpenPersonalDesk: () => void;
  onOpenRequest: (request: RequestData) => void;
};

const TILE_W = 64;
const TILE_H = 32;
const GRID_W = 25;
const GRID_H = 11;
const DING_INTERVAL_MS = 2 * 60 * 1000;

class OfficeScene extends Phaser.Scene {
  private callbacks!: GameCallbacks;
  private floor!: Phaser.GameObjects.Graphics;
  private decor!: Phaser.GameObjects.Container;
  private deliveries = new Map<string, {
    sprite: Phaser.GameObjects.Sprite;
    mood: Phaser.GameObjects.Text;
    state: "walking" | "waiting";
    since: number;
    nextBellAt: number;
  }>();
  private zoomBeforeFocus = 0.8;
  private focusTimer?: Phaser.Time.TimerEvent;
  private dragging = false;
  private previousPointer = { x: 0, y: 0 };

  constructor() { super("OfficeScene"); }
  init(callbacks: GameCallbacks) { this.callbacks = callbacks; }

  preload() {
    // 4 personnages x 10 images : repos, marche, ordinateur, colis et demande.
    this.load.spritesheet("npcs", "/assets/npc-sprites.png", {
      frameWidth: 64,
      frameHeight: 96
    });
    // Vite copie public/sounds/ding.mp3 tel quel dans dist/sounds/ding.mp3.
    this.load.audio("delivery-ding", "/sounds/ding.mp3");
  }

  create() {
    this.createNpcAnimations();
    this.cameras.main.setBackgroundColor("#22342c");
    this.floor = this.add.graphics();
    this.decor = this.add.container(0, 0);
    this.drawWorld();
    this.installCameraControls();
    this.game.events.emit("pixel-office:ready");

    this.time.addEvent({
      delay: 250,
      loop: true,
      callback: () => this.updateDeliveries()
    });
  }

  private createNpcAnimations() {
    // Les images ne sont pas recalculées à chaque frame : Phaser alterne
    // simplement entre les poses pré-dessinées du spritesheet.
    const clips: { name: string; frames: number[]; fps: number; repeat: number }[] = [
      { name: "idle", frames: [0, 1], fps: 0.85, repeat: -1 },
      { name: "walk", frames: [2, 3], fps: 5, repeat: -1 },
      { name: "work", frames: [4, 5], fps: 1.7, repeat: -1 },
      { name: "read", frames: [6], fps: 1, repeat: 0 },
      { name: "request", frames: [7], fps: 1, repeat: 0 },
      { name: "carry", frames: [8, 9], fps: 5, repeat: -1 }
    ];

    for (let variant = 0; variant < 4; variant++) {
      for (const clip of clips) {
        const key = `npc-${variant}-${clip.name}`;
        if (this.anims.exists(key)) continue;
        this.anims.create({
          key,
          frames: this.anims.generateFrameNumbers("npcs", {
            frames: clip.frames.map(f => variant * 10 + f)
          }),
          frameRate: clip.fps,
          repeat: clip.repeat
        });
      }
    }
  }

  private iso(x: number, y: number) {
    return { x: (x - y) * TILE_W / 2, y: (x + y) * TILE_H / 2 };
  }

  private polygon(g: Phaser.GameObjects.Graphics, coords: number[], color: number, border = 0x344a3c) {
    const points: Phaser.Math.Vector2[] = [];
    for (let i = 0; i < coords.length; i += 2) {
      points.push(new Phaser.Math.Vector2(coords[i], coords[i + 1]));
    }
    g.fillStyle(color, 1);
    g.fillPoints(points, true);
    g.lineStyle(1, border, 1);
    g.strokePoints(points, true);
  }

  private drawWorld() {
    // Terrain large, avec extension à gauche pour le guichet personnel.
    for (let y = 0; y < GRID_H; y++) {
      for (let x = -4; x < GRID_W; x++) {
        if (x < 0 && (y < 5 || y > 10)) continue;
        const p = this.iso(x, y);
        const isPath = y === 5 || y === 6 || (x >= 10 && x <= 13 && y >= 3 && y <= 9);
        const isPersonal = x < 2 && y >= 6;
        const color = isPath ? ((x + y) % 2 ? 0xb6b1a1 : 0xc7c3b3)
          : isPersonal ? ((x + y) % 2 ? 0x617f6b : 0x6d9078)
          : ((x + y) % 2 ? 0x668a6e : 0x759b7b);
        this.polygon(this.floor, [p.x, p.y, p.x + 32, p.y + 16, p.x, p.y + 32, p.x - 32, p.y + 16], color);
      }
    }

    this.drawWalls();
    // Un accueil façon aéroport au milieu du bureau.
    this.drawReception(12, 5);
    // Six postes utilisateurs autour de la place.
    const desks = [
      { x: 3, y: 2, name: "LUCAS", color: 0xeaa84f },
      { x: 9, y: 2, name: "SARAH", color: 0x76c98f },
      { x: 18, y: 2, name: "YANIS", color: 0xd87cc7 },
      { x: 21, y: 8, name: "MAYA", color: 0x7fb2ff },
      { x: 15, y: 9, name: "NOA", color: 0xf07b7b },
      { x: 5, y: 9, name: "INES", color: 0x97d36d }
    ];
    for (const d of desks) this.drawWorkstation(d.x, d.y, d.name, d.color);

    // Les meubles et objets qui donnent vie à la place.
    for (const [x, y] of [[0, 1], [7, 0], [13, 0], [23, 1], [23, 10], [1, 10], [17, 6]] as const) {
      this.drawPlant(x, y);
    }
    for (const [x, y] of [[2, 5], [7, 5], [18, 5], [23, 5]] as const) this.drawLamp(x, y);
    this.drawBench(7, 8);
    this.drawBench(19, 8);
    this.drawWaterCooler(23, 3);
    this.drawPersonalCounter(-2, 8);
    // Les coursiers seront créés lorsqu’une vraie demande sera reçue.

    const help = this.add.text(12, 12, "MOLETTE : ZOOM   •   GLISSER : DÉPLACER LA VUE", {
      fontFamily: "monospace", fontSize: "13px", color: "#e3f0e5",
      backgroundColor: "#15251bd9", padding: { x: 8, y: 5 }
    });
    help.setScrollFactor(0).setDepth(100);
  }

  private drawWalls() {
    // Murs du fond : façades avec grandes baies vitrées.
    for (let x = 0; x < GRID_W; x += 2) {
      const p = this.iso(x, 0);
      const g = this.add.graphics();
      this.polygon(g, [p.x - 32, p.y + 16, p.x + 32, p.y + 48, p.x + 32, p.y - 18, p.x - 32, p.y - 50], 0xa7b5ac, 0x657b70);
      this.polygon(g, [p.x - 25, p.y - 37, p.x + 25, p.y - 12, p.x + 25, p.y + 23, p.x - 25, p.y - 2], 0x77afbb, 0x38576b);
      g.lineStyle(3, 0x405963);
      g.lineBetween(p.x, p.y - 24, p.x, p.y + 11);
      g.lineBetween(p.x - 25, p.y - 18, p.x + 25, p.y + 7);
      this.decor.add(g);
    }
    const signPos = this.iso(12, 0);
    const sign = this.add.text(signPos.x, signPos.y - 63, "PIXEL OFFICE", {
      fontFamily: "monospace", fontSize: "16px", color: "#f6eed2",
      backgroundColor: "#344b46", padding: { x: 9, y: 5 }
    }).setOrigin(0.5);
    this.decor.add(sign);
  }

  private drawReception(x: number, y: number) {
    const p = this.iso(x, y);
    const c = this.add.container(p.x, p.y);
    const g = this.add.graphics();
    // Grand comptoir d'accueil en U, avec façade, plateau et bande lumineuse.
    this.polygon(g, [-94, 3, -50, 23, -50, 51, -94, 31], 0x567074, 0x294348);
    this.polygon(g, [-50, 23, 22, 58, 22, 86, -50, 51], 0x43616a, 0x294348);
    this.polygon(g, [22, 58, 94, 23, 94, 51, 22, 86], 0x567074, 0x294348);
    this.polygon(g, [-96, -4, -52, 16, 20, 51, 64, 29, 94, 40, 22, 78, -50, 44, -94, 22], 0xc5a47b, 0x664e3b);
    g.fillStyle(0x86dbe3);
    g.fillRect(-46, 55, 62, 4);
    c.add(g);
    c.add(this.add.text(0, 44, "ACCUEIL", {
      fontFamily: "monospace", fontSize: "14px", fontStyle: "bold", color: "#f9f3e8"
    }).setOrigin(0.5));
    const computer = this.add.graphics();
    computer.fillStyle(0x243842).fillRect(-12, -7, 26, 18);
    computer.fillStyle(0x91d7da).fillRect(-9, -4, 20, 12);
    computer.fillStyle(0x39413f).fillRect(-2, 11, 5, 8);
    c.add(computer);
    c.add(this.add.rectangle(-36, 24, 18, 10, 0xf2e7cc).setAngle(17));
    this.decor.add(c);

    const worker = this.createMiniCharacter(p.x + 38, p.y + 18, 0x79a8d0);
    this.decor.add(worker);
    const zone = this.add.zone(p.x, p.y + 22, 190, 110).setInteractive({ cursor: "pointer" });
    zone.on("pointerdown", () => {
      this.focusOn(p.x, p.y + 25);
      // L'employé prépare une demande, puis reprend son travail.
      worker.play("npc-1-request");
      this.time.delayedCall(1700, () => {
        if (worker.active) worker.play("npc-1-work");
      });
      this.callbacks.onOpenCentralDesk();
    });
    this.decor.add(zone);
    this.decor.add(this.label(p.x, p.y + 102, "BUREAU CENTRAL • CLIQUER"));
  }

  private drawWorkstation(x: number, y: number, name: string, color: number) {
    const p = this.iso(x, y);
    const c = this.add.container(p.x, p.y);
    const g = this.add.graphics();
    // Tapis délimitant chaque emplacement.
    this.polygon(g, [-54, 4, 0, 29, 54, 4, 0, -21], 0x59736d, 0x35534f);
    // Plateau et pieds d'un vrai petit bureau.
    this.polygon(g, [-39, -6, 4, -24, 47, -4, 4, 17], 0xb4885d, 0x60452e);
    g.fillStyle(0x765238).fillRect(-27, 10, 7, 23);
    g.fillStyle(0x765238).fillRect(29, 7, 7, 23);
    g.fillStyle(0x253745).fillRect(-2, -36, 27, 20);
    g.fillStyle(color).fillRect(1, -33, 21, 14);
    g.fillStyle(0x26313a).fillRect(10, -16, 6, 10);
    g.fillStyle(0xe6dbcb).fillRect(-8, -5, 17, 5);
    c.add(g);
    this.decor.add(c);
    this.decor.add(this.createMiniCharacter(p.x + 41, p.y + 35, color));
    this.decor.add(this.label(p.x + 7, p.y + 74, name));
  }

  private drawPersonalCounter(x: number, y: number) {
    const p = this.iso(x, y);
    const c = this.add.container(p.x, p.y);
    const g = this.add.graphics();
    // Zone personnelle séparée, accessible depuis l'allée centrale.
    this.polygon(g, [-77, 2, 0, 41, 77, 2, 0, -37], 0x4a776d, 0x315c54);
    this.polygon(g, [-70, 3, 0, 38, 70, 3, 70, 35, 0, 72, -70, 35], 0x735139, 0x463426);
    this.polygon(g, [-70, -5, 0, -39, 70, -5, 0, 31], 0xc49662, 0x624a35);
    g.fillStyle(0xe8cb6a).fillEllipse(26, -4, 14, 8);
    g.fillStyle(0xf6e79e).fillCircle(26, -8, 5);
    // Corbeille de colis.
    g.fillStyle(0x8a5f38).fillRect(-52, 4, 26, 18);
    g.lineStyle(2, 0x54391f).strokeRect(-52, 4, 26, 18);
    c.add(g);
    this.decor.add(c);
    this.decor.add(this.label(p.x, p.y + 89, "MON GUICHET • CLIQUER"));
    const zone = this.add.zone(p.x, p.y + 10, 135, 90).setInteractive({ cursor: "pointer" });
    zone.on("pointerdown", () => {
      this.focusOn(p.x, p.y + 15);
      this.callbacks.onOpenPersonalDesk();
    });
    this.decor.add(zone);
  }

  private drawPlant(x: number, y: number) {
    const p = this.iso(x, y);
    const g = this.add.graphics();
    g.fillStyle(0x926749).fillRect(p.x - 9, p.y + 5, 18, 17);
    g.fillStyle(0x59402e).fillRect(p.x - 10, p.y + 4, 20, 5);
    g.fillStyle(0x2d6948).fillEllipse(p.x - 7, p.y - 12, 20, 32);
    g.fillStyle(0x429466).fillEllipse(p.x + 7, p.y - 18, 23, 35);
    g.fillStyle(0x61ad78).fillEllipse(p.x, p.y - 30, 18, 20);
    this.decor.add(g);
  }

  private drawLamp(x: number, y: number) {
    const p = this.iso(x, y);
    const g = this.add.graphics();
    g.fillStyle(0xf2db92, 0.14).fillEllipse(p.x, p.y + 10, 55, 24);
    g.fillStyle(0x41565a).fillRect(p.x - 2, p.y - 77, 4, 87);
    g.fillStyle(0xe9c87c).fillRect(p.x - 15, p.y - 81, 30, 9);
    g.fillStyle(0xfff0b3).fillRect(p.x - 11, p.y - 72, 22, 4);
    this.decor.add(g);
  }

  private drawBench(x: number, y: number) {
    const p = this.iso(x, y);
    const g = this.add.graphics();
    this.polygon(g, [p.x - 34, p.y, p.x, p.y - 14, p.x + 34, p.y, p.x, p.y + 16], 0xa57b54);
    g.fillStyle(0x715037).fillRect(p.x - 24, p.y + 9, 6, 16);
    g.fillStyle(0x715037).fillRect(p.x + 18, p.y + 9, 6, 16);
    this.decor.add(g);
  }

  private drawWaterCooler(x: number, y: number) {
    const p = this.iso(x, y);
    const g = this.add.graphics();
    g.fillStyle(0xd7e3e5).fillRect(p.x - 12, p.y - 28, 24, 35);
    g.fillStyle(0x7bc9dc).fillRect(p.x - 8, p.y - 49, 16, 25);
    g.fillStyle(0x4f8093).fillRect(p.x - 8, p.y - 5, 16, 4);
    this.decor.add(g);
  }

  private label(x: number, y: number, value: string) {
    return this.add.text(x, y, value, {
      fontFamily: "monospace", fontSize: "12px", fontStyle: "bold",
      color: "#f6f6eb", backgroundColor: "#263c32e8",
      padding: { x: 6, y: 4 }
    }).setOrigin(0.5);
  }

  /** Keep the visible queue in sync with real, locally stored inbox messages. */
  public setDeliveries(messages: OfficeRequest[]) {
    // Une demande consultée ne garde plus de coursier ni de rappel sonore.
    const active = messages.filter(r => !r.archived && !r.viewed).slice(0, 7);
    const ids = new Set(active.map(r => r.id));
    for (const [id, delivery] of this.deliveries) {
      if (!ids.has(id)) {
        this.tweens.killTweensOf(delivery.sprite);
        delivery.sprite.destroy();
        delivery.mood.destroy();
        this.deliveries.delete(id);
      }
    }
    active.forEach((request, index) => {
      if (this.deliveries.has(request.id)) return;
      this.spawnDelivery(request, index);
    });
  }

  private spawnDelivery(request: OfficeRequest, index: number) {
    const start = this.iso(12, 6);
    const end = this.iso(-2 + index * 1.4, 9 - index * 0.28);
    const variant = index % 4;
    const sprite = this.add.sprite(start.x, start.y + 18, "npcs", variant * 10 + 8);
    sprite.setOrigin(0.5, 0.96);
    sprite.play(`npc-${variant}-carry`);
    sprite.setInteractive({ cursor: "pointer" });
    sprite.on("pointerdown", () => {
      this.focusOn(sprite.x, sprite.y - 28);
      sprite.play(`npc-${variant}-read`);
      this.time.delayedCall(1200, () => {
        if (sprite.active) sprite.play(`npc-${variant}-request`);
      });
      this.callbacks.onOpenRequest(request);
    });
    this.decor.add(sprite);
    const mood = this.add.text(start.x, start.y - 83, "", {
      fontFamily: "monospace", fontSize: "22px", fontStyle: "bold",
      color: "#ffd564", backgroundColor: "#25372ecc",
      padding: { x: 3, y: 1 }
    }).setOrigin(0.5);
    this.decor.add(mood);
    const delivery = {
      sprite, mood,
      state: "walking" as "walking" | "waiting",
      since: 0,
      nextBellAt: 0
    };
    this.deliveries.set(request.id, delivery);
    this.tweens.add({
      targets: sprite,
      x: end.x,
      y: end.y + 8,
      duration: 5300 + index * 650,
      ease: "Linear",
      onComplete: () => {
        if (!sprite.active) return;
        delivery.state = "waiting";
        delivery.since = this.time.now;
        delivery.nextBellAt = Date.now() + DING_INTERVAL_MS;
        sprite.play(`npc-${variant}-request`);
        this.tweens.add({
          targets: sprite,
          scaleY: 1.014,
          duration: 1500,
          yoyo: true,
          repeat: -1,
          ease: "Sine.easeInOut"
        });
        this.ringBell();
      }
    });
  }

  /** Visual effect: a courier carries the newly authored request to a colleague's desk. */
  public dispatchCourier(recipient: string) {
    const destinations: Record<string, [number, number]> = {
      lucas: [3, 2], sarah: [9, 2], yanis: [18, 2],
      maya: [21, 8], noa: [15, 9], ines: [5, 9]
    };
    const [x, y] = destinations[recipient] || [18, 5];
    const start = this.iso(12, 6);
    const target = this.iso(x, y);
    const courier = this.add.sprite(start.x, start.y + 18, "npcs", 8);
    courier.setOrigin(0.5, 0.96).play("npc-0-carry");
    this.decor.add(courier);
    this.tweens.add({
      targets: courier, x: target.x, y: target.y + 25,
      duration: 4200, ease: "Linear",
      onComplete: () => {
        if (!courier.active) return;
        courier.play("npc-0-request");
        this.time.delayedCall(850, () => courier.destroy());
      }
    });
  }

  private updateDeliveries() {
    for (const delivery of this.deliveries.values()) {
      if (!delivery.sprite.active) continue;
      delivery.mood.setPosition(delivery.sprite.x, delivery.sprite.y - 85);
      if (delivery.state !== "waiting") continue;
      const elapsed = this.time.now - delivery.since;
      const anger = Math.min(100, Math.floor(elapsed / 300));
      const symbol = anger >= 100 ? "‼" : anger >= 65 ? "!" : anger >= 35 ? "…" : "";
      delivery.mood.setText(symbol);
      delivery.mood.setColor(anger >= 100 ? "#ff6655" : "#ffda76");
      // Horloge réelle : un unique rappel par coursier toutes les 2 minutes.
      // Après une mise en veille, aucun « rattrapage » de dizaines de sons.
      if (Date.now() >= delivery.nextBellAt) {
        this.ringBell();
        delivery.nextBellAt = Date.now() + DING_INTERVAL_MS;
      }
    }
  }

  private ringBell(): boolean {
    // Aucun bip généré : on lit seulement le MP3 fourni par l'utilisateur.
    if (!this.cache.audio.exists("delivery-ding")) {
      console.warn("Fichier sonore absent : public/sounds/ding.mp3");
      return false;
    }
    try {
      return this.sound.play("delivery-ding", { volume: 0.7 });
    } catch (error) {
      console.warn("Impossible de jouer ding.mp3", error);
      return false;
    }
  }

  public testDeliverySound(): boolean {
    return this.ringBell();
  }

  private installCameraControls() {
    const cam = this.cameras.main;
    this.setInitialCamera();

    this.input.on("wheel", (pointer: Phaser.Input.Pointer, _objects: Phaser.GameObjects.GameObject[], _dx: number, dy: number) => {
      const before = cam.getWorldPoint(pointer.x, pointer.y);
      const next = Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 0.35, 2.8);
      cam.setZoom(next);
      const after = cam.getWorldPoint(pointer.x, pointer.y);
      cam.scrollX += before.x - after.x;
      cam.scrollY += before.y - after.y;
    });

    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (!pointer.leftButtonDown()) return;
      this.dragging = true;
      this.previousPointer = { x: pointer.x, y: pointer.y };
    });
    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (!this.dragging || !pointer.isDown) return;
      cam.scrollX -= (pointer.x - this.previousPointer.x) / cam.zoom;
      cam.scrollY -= (pointer.y - this.previousPointer.y) / cam.zoom;
      this.previousPointer = { x: pointer.x, y: pointer.y };
    });
    this.input.on("pointerup", () => { this.dragging = false; });
    this.input.on("gameout", () => { this.dragging = false; });

    // Ne reconstruit pas la scène au redimensionnement : le PNJ conserve son trajet.
    this.scale.on("resize", () => {
      // L'utilisateur garde son niveau de zoom et sa position.
    });
  }

  private setInitialCamera() {
    const cam = this.cameras.main;
    const z = Phaser.Math.Clamp(Math.min(this.scale.width / 1200, this.scale.height / 440), 0.62, 1.05);
    cam.setZoom(z);
    cam.centerOn(140, 260);
  }

  private focusOn(x: number, y: number) {
    const cam = this.cameras.main;
    this.focusTimer?.remove(false);
    this.zoomBeforeFocus = cam.zoom;
    cam.setZoom(Math.min(2.1, Math.max(cam.zoom, 1.25)));
    cam.centerOn(x, y);
    this.focusTimer = this.time.delayedCall(1300, () => {
      cam.setZoom(this.zoomBeforeFocus);
      cam.centerOn(140, 260);
    });
  }

  private createMiniCharacter(
    x: number,
    y: number,
    shirtColor: number,
    carrying = false
  ): Phaser.GameObjects.Sprite {
    // 4 apparences différentes, tous dans un style pixel art chaleureux.
    const variants: Record<number, number> = {
      [0x79a8d0]: 1, // Accueil
      [0xeaa84f]: 0, // Lucas
      [0x76c98f]: 1, // Sarah
      [0xd87cc7]: 2, // Yanis
      [0x7fb2ff]: 3, // Maya
      [0xf07b7b]: 2, // Noa
      [0x97d36d]: 3  // Inès
    };
    const variant = carrying ? 0 : (variants[shirtColor] ?? 0);
    const sprite = this.add.sprite(x, y, "npcs", variant * 10);
    sprite.setOrigin(0.5, 0.96);
    sprite.play(`npc-${variant}-${carrying ? "carry" : "work"}`);

    if (carrying) {
      sprite.setInteractive({ cursor: "pointer" });
    } else {
      // Micro-mouvement lent pour que les employés ne soient jamais figés.
      this.tweens.add({
        targets: sprite,
        scaleY: 1.012,
        duration: 1700 + variant * 170,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut"
      });
    }

    return sprite;
  }
}

export function startGame(container: HTMLElement, callbacks: GameCallbacks) {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent: container,
    backgroundColor: "#22342c",
    pixelArt: true,
    antialias: false,
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: container.clientWidth,
      height: container.clientHeight
    },
    scene: [new OfficeScene()],
    callbacks: {
      postBoot: (game) => game.scene.start("OfficeScene", callbacks)
    }
  });
}

/** Called by the UI whenever the persisted inbox changes. */
export function setDeliveryRequests(game: Phaser.Game, requests: OfficeRequest[]) {
  try {
    const scene = game.scene.getScene("OfficeScene") as OfficeScene;
    if (scene?.sys.isActive()) scene.setDeliveries(requests);
  } catch {
    // Scene assets may still be loading during the first refresh.
  }
}

/** Launch a temporary outbound courier animation after a successful local save. */
export function animateOutgoingCourier(game: Phaser.Game, recipient: string) {
  try {
    const scene = game.scene.getScene("OfficeScene") as OfficeScene;
    if (scene?.sys.isActive()) scene.dispatchCourier(recipient);
  } catch {
    // Scene is not fully initialised yet.
  }
}

/** Bouton des paramètres, permet aussi de débloquer la lecture audio après un clic. */
export function testNotificationSound(game: Phaser.Game): boolean {
  try {
    const scene = game.scene.getScene("OfficeScene") as OfficeScene;
    return scene?.sys.isActive() ? scene.testDeliverySound() : false;
  } catch {
    return false;
  }
}