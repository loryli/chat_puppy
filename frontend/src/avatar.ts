// avatar.ts —— Q 版角色「小趴」的 Canvas 渲染 + 状态驱动
//
// 提供：
//   - setMood(state): 切换状态（idle/listening/thinking/speaking）
//   - feedAudioVolume(rms): 喂入实时音量，驱动嘴型开合（0~1）
//   - 内置：眨眼、呼吸/晃动、腮红、爱心等可爱细节

export type AvatarState = "idle" | "listening" | "thinking" | "speaking";

export class Avatar {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private state: AvatarState = "idle";

  // 动画参数
  private mouthOpen = 0; // 0~1，嘴张开程度（由音量驱动）
  private blinkPhase = 0; // 眨眼相位
  private time = 0;
  private raf = 0;

  // 目标嘴型（音量瞬时值），用于平滑
  private mouthTarget = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.loop();
  }

  setState(s: AvatarState) {
    this.state = s;
    // listening/thinking/speaking 时让角色有不同的神态
  }

  // 喂入一段音频的 RMS（0~1），映射到嘴型开合
  feedAudioRms(rms: number) {
    this.mouthTarget = Math.max(0, Math.min(1, rms * 3)); // 放大敏感度
  }

  private loop = () => {
    this.time += 0.016; // 约 60fps
    // 眨眼：每 3~5 秒一次，快速闭合
    const cycle = this.time % 4;
    this.blinkPhase = cycle > 3.8 ? Math.min(1, (cycle - 3.8) / 0.15) : 0;
    // 嘴型平滑
    this.mouthOpen += (this.mouthTarget - this.mouthOpen) * 0.4;
    // 非 speaking 状态时嘴慢慢合上
    if (this.state !== "speaking") this.mouthOpen *= 0.92;

    this.draw();
    this.raf = requestAnimationFrame(this.loop);
  };

  private draw() {
    const ctx = this.ctx;
    // 固定逻辑坐标 320x320，拥抱 dpr 清晰度
    const w = 320;
    const h = 320;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) * 0.28; // 脸半径

    // 身体轻微晃动（呼吸）
    const sway = Math.sin(this.time * 1.5) * 3;

    // ---- 耳朵 ----
    this.drawEar(cx - r * 0.7, cy - r * 0.7, -0.6, r, sway);
    this.drawEar(cx + r * 0.7, cy - r * 0.7, 0.6, r, sway);

    // ---- 脸 ----
    ctx.save();
    ctx.translate(cx, cy + sway);
    const grad = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.2, 0, 0, r * 1.4);
    grad.addColorStop(0, "#fff3e0");
    grad.addColorStop(1, "#f5d0b0");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#d9a066";
    ctx.lineWidth = 2;
    ctx.stroke();

    // ---- 眼睛 ----
    const eyeY = -r * 0.2;
    const eyeDX = r * 0.42;
    const eyeR = r * 0.12;
    const blink = this.blinkPhase;

    if (blink > 0) {
      // 闭眼：画一条弧线
      this.drawClosedEye(-eyeDX, eyeY, eyeR);
      this.drawClosedEye(eyeDX, eyeY, eyeR);
    } else {
      // 睁眼：大圆眼睛 + 高光
      this.drawOpenEye(-eyeDX, eyeY, eyeR);
      this.drawOpenEye(eyeDX, eyeY, eyeR);
    }

    // ---- 腮红 ----
    const blushA = this.state === "listening" ? 0.6 : 0.35;
    ctx.fillStyle = `rgba(255, 150, 170, ${blushA})`;
    ctx.beginPath();
    ctx.ellipse(-r * 0.6, r * 0.1, r * 0.14, r * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(r * 0.6, r * 0.1, r * 0.14, r * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();

    // ---- 嘴 ----
    this.drawMouth(r);

    ctx.restore();

    // ---- 状态指示（思考时冒泡 / 聆听时音符）----
    if (this.state === "thinking") this.drawThinkingBubble(cx, cy - r * 1.2, r);
    if (this.state === "listening") this.drawNote(cx + r * 0.8, cy - r * 1.1);

    // ---- 爱心（speaking 时偶尔冒）----
    if (this.state === "speaking" && Math.sin(this.time * 3) > 0.6) {
      this.drawHeart(cx - r * 0.9, cy - r * 0.8);
    }
  }

  private drawEar(x: number, y: number, dir: number, r: number, sway: number) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y + sway);
    ctx.rotate(dir * 0.5);
    ctx.fillStyle = "#f5d0b0";
    ctx.beginPath();
    ctx.moveTo(-r * 0.25, r * 0.1);
    ctx.quadraticCurveTo(0, -r * 0.55, r * 0.25, r * 0.1);
    ctx.quadraticCurveTo(0, r * 0.2, -r * 0.25, r * 0.1);
    ctx.fill();
    ctx.strokeStyle = "#d9a066";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  private drawOpenEye(x: number, y: number, r: number) {
    const ctx = this.ctx;
    // 眼睛白
    ctx.fillStyle = "#3a2a1a";
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 1.15, 0, 0, Math.PI * 2);
    ctx.fill();
    // 高光
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(x - r * 0.3, y - r * 0.35, r * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawClosedEye(x: number, y: number, r: number) {
    const ctx = this.ctx;
    ctx.strokeStyle = "#3a2a1a";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(x, y, r * 0.9, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
  }

  private drawMouth(r: number) {
    const ctx = this.ctx;
    const my = r * 0.35;
    if (this.state === "speaking") {
      // 张嘴：椭圆，大小随音量
      const open = 0.15 + this.mouthOpen * 0.6;
      ctx.fillStyle = "#5a3a28";
      ctx.beginPath();
      ctx.ellipse(0, my, r * 0.28, r * open, 0, 0, Math.PI * 2);
      ctx.fill();
      // 舌头（张嘴大时露出）
      if (this.mouthOpen > 0.4) {
        ctx.fillStyle = "#e88";
        ctx.beginPath();
        ctx.ellipse(0, my + r * open * 0.5, r * 0.16, r * open * 0.4, 0, 0, Math.PI);
        ctx.fill();
      }
    } else if (this.state === "listening") {
      // 认真听：微张的小嘴
      ctx.fillStyle = "#5a3a28";
      ctx.beginPath();
      ctx.ellipse(0, my, r * 0.14, r * 0.08, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (this.state === "thinking") {
      // 思考：抿嘴歪
      ctx.strokeStyle = "#5a3a28";
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(r * 0.08, my, r * 0.18, 0.2 * Math.PI, 0.8 * Math.PI);
      ctx.stroke();
    } else {
      // idle：微笑
      ctx.strokeStyle = "#5a3a28";
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(0, my - r * 0.08, r * 0.2, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    }
  }

  private drawThinkingBubble(cx: number, cy: number, r: number) {
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    for (let i = 0; i < 3; i++) {
      const t = (this.time * 2 + i * 0.33) % 1;
      const x = cx + (i - 1) * r * 0.25;
      const y = cy + Math.sin((this.time * 4 + i)) * r * 0.1;
      ctx.beginPath();
      ctx.arc(x, y, r * (0.06 + t * 0.05), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawNote(x: number, y: number) {
    const ctx = this.ctx;
    ctx.fillStyle = "#ff9ecd";
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#ff9ecd";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 4, y);
    ctx.lineTo(x + 4, y - 12);
    ctx.lineTo(x + 10, y - 9);
    ctx.stroke();
  }

  private drawHeart(x: number, y: number) {
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(255,120,160,0.7)";
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.moveTo(0, 6);
    ctx.bezierCurveTo(-10, -2, -6, -12, 0, -6);
    ctx.bezierCurveTo(6, -12, 10, -2, 0, 6);
    ctx.fill();
    ctx.restore();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
  }
}
