// avatar.ts —— 2D Q版角色「小趴」：加载外部图片 + 状态动效 + 鼠标交互
//
// 图片来自 frontend/public/character.png（Q版贴纸风格，实色背景）
// 效果（第一步，无需五官坐标）：
//   - 待机：轻微上下浮动 + 微倾斜（呼吸）
//   - 聆听：轻微放大 + 音符/波纹提示
//   - 说话：轻微缩放 + 上下浮动 + 语音波形
//   - 点击：轻轻弹跳
//   - 思考：可爱思考气泡（省略号）
//   - 鼠标视线：角色整体轻微朝鼠标方向倾斜（代替眼球跟随）

export type AvatarState = "idle" | "listening" | "thinking" | "speaking";

interface MousePos {
  x: number;
  y: number;
  active: boolean;
}

export class Avatar {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private state: AvatarState = "idle";

  private W = 512;
  private H = 512;

  // 图片
  private img: HTMLImageElement | null = null;
  private imgLoaded = false;

  private time = 0;
  private raf = 0;

  // 鼠标
  private mouse: MousePos = { x: this.W / 2, y: this.H * 0.3, active: false };
  private gazeX = 0; // 整体倾斜 -1~1
  private gazeY = 0;

  // 点击弹跳
  private bounce = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;

    // 加载角色图片
    const image = new Image();
    image.onload = () => {
      this.img = image;
      this.imgLoaded = true;
    };
    image.src = "/character.png";

    // 鼠标交互
    canvas.addEventListener("mousemove", (e) => {
      const r = canvas.getBoundingClientRect();
      this.mouse.x = e.clientX - r.left;
      this.mouse.y = e.clientY - r.top;
      this.mouse.active = true;
    });
    canvas.addEventListener("mouseleave", () => {
      this.mouse.active = false;
    });
    canvas.addEventListener("click", () => {
      this.bounce = 1;
    });

    this.loop();
  }

  setState(s: AvatarState) {
    this.state = s;
  }

  // 说话时喂音量（0~1），驱动「语音波形」幅度
  feedAudioRms(rms: number) {
    this.volume = Math.max(0, Math.min(1, rms * 3));
  }

  private volume = 0;

  private loop = () => {
    this.time += 0.016;

    // 整体视线：朝鼠标方向轻微倾斜（用逻辑坐标）
    const cw = this.W;
    const ch = this.H;
    const cx = cw / 2;
    const cy = ch / 2;
    if (this.mouse.active) {
      // 鼠标坐标是 CSS 像素，需要映射到逻辑坐标比例
      const rect = this.canvas.getBoundingClientRect();
      const mx = ((this.mouse.x / (rect.width || 1)) * cw);
      const my = ((this.mouse.y / (rect.height || 1)) * ch);
      const tx = (mx - cx) / (cw * 0.7);
      const ty = (my - cy) / (ch * 0.7);
      this.gazeX += (Math.max(-1, Math.min(1, tx)) - this.gazeX) * 0.1;
      this.gazeY += (Math.max(-1, Math.min(1, ty)) - this.gazeY) * 0.1;
    } else {
      this.gazeX *= 0.95;
      this.gazeY *= 0.95;
    }

    // 音量衰减
    this.volume *= 0.85;

    // 点击弹跳衰减
    this.bounce *= 0.9;

    this.draw();
    this.raf = requestAnimationFrame(this.loop);
  };

  private draw() {
    const ctx = this.ctx;
    // 固定逻辑坐标（与 CSS 显示尺寸解耦，避免反馈循环）
    const w = this.W;
    const h = this.H;

    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.round(w * dpr);
    const targetH = Math.round(h * dpr);
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;

    ctx.save();
    ctx.translate(cx, cy);

    // ---- 状态动效参数 ----
    let scale = 1;
    let offsetY = 0;
    let tilt = this.gazeX * 0.06; // 整体轻微倾斜（视线跟随）

    switch (this.state) {
      case "idle":
        offsetY = Math.sin(this.time * 1.8) * 5; // 轻微浮动
        break;
      case "listening":
        scale = 1.04 + Math.sin(this.time * 3) * 0.01; // 轻微放大 + 微动
        offsetY = Math.sin(this.time * 1.8) * 3;
        break;
      case "speaking":
        scale = 1 + Math.sin(this.time * 8) * 0.015 + this.volume * 0.03; // 随音量缩放
        offsetY = Math.sin(this.time * 2.5) * 4;
        break;
      case "thinking":
        offsetY = Math.sin(this.time * 1.5) * 3;
        break;
    }

    // 点击弹跳
    const bounceOffset = this.bounce * Math.sin(this.bounce * Math.PI) * -14;

    ctx.scale(scale, scale);
    ctx.rotate(tilt);
    ctx.translate(0, offsetY + bounceOffset);

    // ---- 绘制角色图片（object-fit contain，贴纸完整保留）----
    this.drawImage();

    ctx.restore();

    // ---- 浮层特效 ----
    this.drawEffects(cx, cy);
  }

  private drawImage() {
    if (!this.imgLoaded || !this.img) {
      // 未加载时画占位
      const ctx = this.ctx;
      ctx.fillStyle = "rgba(255,255,255,0.1)";
      ctx.beginPath();
      ctx.arc(0, 0, 60, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    const ctx = this.ctx;
    const iw = this.img.width;
    const ih = this.img.height;

    // object-fit: contain —— 等比缩放到逻辑画布内，留少量边距（贴纸留白）
    const maxW = this.W * 0.86;
    const maxH = this.H * 0.86;
    const scale = Math.min(maxW / iw, maxH / ih);
    const dw = iw * scale;
    const dh = ih * scale;

    ctx.drawImage(this.img, -dw / 2, -dh / 2, dw, dh);
  }

  private drawEffects(cx: number, cy: number) {
    const ctx = this.ctx;

    if (this.state === "listening") {
      // 聆听：音符 + 波纹
      ctx.fillStyle = "#ff9ecd";
      ctx.font = "28px serif";
      ctx.fillText("♪", cx + 120, cy - 120 + Math.sin(this.time * 3) * 5);
      // 音频波纹
      for (let i = 0; i < 3; i++) {
        const t = (this.time * 2 + i * 0.33) % 1;
        const r = 30 + t * 60 + this.volume * 30;
        const alpha = 1 - t;
        ctx.strokeStyle = `rgba(255, 158, 205, ${alpha * 0.6})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy + 60, r, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    if (this.state === "speaking") {
      // 语音波形（随音量跳动）
      const bars = 7;
      const baseY = cy + 140;
      ctx.fillStyle = "#ff9ecd";
      for (let i = 0; i < bars; i++) {
        const bx = cx + (i - (bars - 1) / 2) * 14;
        const bh = 6 + Math.abs(Math.sin(this.time * 6 + i * 0.9)) * 14 + this.volume * 18;
        ctx.fillRect(bx - 3, baseY - bh / 2, 6, bh);
      }
      // 爱心
      for (let i = 0; i < 2; i++) {
        const t = (this.time * 1.5 + i * 0.5) % 1;
        const x = cx + (i === 0 ? -130 : 130);
        const y = cy - 130 - t * 100;
        this.drawHeart(x, y, 12, 1 - t);
      }
    }

    if (this.state === "thinking") {
      // 思考省略号
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      for (let i = 0; i < 3; i++) {
        const t = (this.time * 2 + i * 0.33) % 1;
        ctx.beginPath();
        ctx.arc(cx + (i - 1) * 28, cy - 140 + Math.sin(this.time * 4 + i) * 3, 5 + t * 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawHeart(x: number, y: number, s: number, alpha: number) {
    const ctx = this.ctx;
    ctx.fillStyle = `rgba(255, 120, 160, ${alpha})`;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
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
