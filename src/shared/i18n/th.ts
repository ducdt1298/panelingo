// Thai UI catalog. PURE.

import type { Catalog } from "./en.ts";

const errors: Catalog["errors"] = {
  "api.unreachable": {
    title: "เชื่อมต่อ endpoint AI ไม่ได้",
    hint: "ตรวจสอบ Base URL ในหน้าตัวเลือก และตรวจดูว่าเซิร์ฟเวอร์ (หรือโมเดลในเครื่องของคุณ) กำลังทำงานอยู่",
  },
  "api.lna_blocked": {
    title: "Chrome บล็อกการเชื่อมต่อไปยังเซิร์ฟเวอร์ AI ภายในของคุณ",
    hint: "เปิดการตั้งค่าเว็บไซต์ของส่วนขยาย → การเข้าถึงเครือข่ายภายใน (Local network access) → อนุญาต",
  },
  "api.unauthorized": {
    title: "Endpoint AI ปฏิเสธคีย์ API",
    hint: "ป้อนคีย์ API ที่ถูกต้องในหน้าตัวเลือก แล้วการแปลจะดำเนินต่อโดยอัตโนมัติ",
  },
  "api.config": {
    title: "ตั้งค่า endpoint AI หรือโมเดลไม่ถูกต้อง",
    hint: "ตรวจสอบ Base URL และเลือกโมเดลที่รับภาพได้ (vision) ในหน้าตัวเลือก",
  },
  "api.rate_limit": {
    title: "ผู้ให้บริการ AI กำลังจำกัดจำนวนคำขอ",
    hint: "ส่วนขยายจะชะลอความเร็วและลองใหม่เอง",
  },
  "api.upstream": { title: "เซิร์ฟเวอร์ AI ผิดพลาด กำลังลองใหม่", hint: "" },
  "api.context_length": { title: "คำขอยาวเกินไป กำลังแบ่งเป็นส่วนย่อย", hint: "" },
  "api.timeout": { title: "AI ใช้เวลาตอบนานเกินไป", hint: "ส่วนขยายจะลองใหม่อีกหนึ่งครั้ง" },
  "api.truncated": { title: "คำตอบถูกตัดกลางคัน กำลังแปลต่อ", hint: "" },
  "api.partial": { title: "AI แปลบอลลูนคำพูดไม่ครบ กำลังขออีกครั้ง", hint: "" },
  "api.empty": { title: "AI ตอบกลับมาว่างเปล่า กำลังลองใหม่", hint: "" },
  "api.too_large": { title: "ภาพใหญ่เกินกว่าจะส่งได้ กำลังย่อขนาด", hint: "" },
  "api.bad_request": { title: "คำขอถูกปฏิเสธ (บั๊ก)", hint: "ส่งออกบันทึกดีบักจากหน้าตัวเลือก" },
  "api.protocol": { title: "รูปแบบคำตอบจาก endpoint AI ไม่ตรงตามที่คาดไว้", hint: "" },
  "llm.refused": { title: "AI ปฏิเสธที่จะแปล", hint: "บอลลูนคำพูดจะคงข้อความต้นฉบับไว้" },
  "llm.missing": { title: "ยังไม่ได้แปล", hint: "กด “แปลอีกครั้ง” เพื่อลองแปลเฉพาะบอลลูนคำพูดนี้ใหม่" },
  "llm.format": { title: "คำตอบจาก AI ผิดรูปแบบ กำลังลองใหม่", hint: "" },
  "image.url_blocked": { title: "ภาพถูกบล็อกเพื่อความปลอดภัย", hint: "" },
  "image.http": {
    title: "โหลดภาพไม่ได้",
    hint: "หากเว็บไซต์กำหนดให้ต้องลงชื่อเข้าใช้ ให้เปิด “ส่งคุกกี้พร้อมคำขอภาพ” ในป๊อปอัป",
  },
  "image.not_image": { title: "ไม่ใช่ไฟล์ภาพ", hint: "" },
  "image.too_large": { title: "ภาพใหญ่เกินไป", hint: "" },
  "image.decode": { title: "ถอดรหัสภาพไม่ได้", hint: "" },
  "image.capture_unavailable": { title: "เลื่อนไปที่ภาพเพื่อแปล", hint: "" },
  "image.capture_blocked": {
    title: "ภาพนี้อ่านได้จากการจับภาพหน้าจอเท่านั้น",
    hint: "เปิดการแปลสำหรับเว็บไซต์นี้และให้แท็บนี้อยู่ด้านหน้า แล้วลองอีกครั้ง",
  },
  "detector.webgpu_unavailable": { title: "กำลังตรวจจับข้อความด้วย CPU (ช้ากว่า)", hint: "" },
  "detector.canary_mismatch": { title: "GPU ให้ผลลัพธ์ไม่สม่ำเสมอ กำลังใช้ CPU แทน", hint: "" },
  "detector.model_integrity": {
    title: "โมเดลตรวจจับข้อความเสียหาย",
    hint: "ติดตั้งส่วนขยายใหม่ (สำหรับนักพัฒนา: npm run fetch-models แล้ว npm run build)",
  },
  "detector.init": { title: "เริ่มการตรวจจับข้อความไม่ได้", hint: "ส่งออกบันทึกดีบักจากหน้าตัวเลือก" },
  "detector.run": { title: "การตรวจจับข้อความล้มเหลว", hint: "" },
  "engine.unavailable": {
    title: "เริ่มเอนจินแปลไม่ได้",
    hint: "โหลดหน้าเว็บใหม่ หรือปิดแล้วเปิดส่วนขยายอีกครั้ง",
  },
  "engine.closing": { title: "เอนจินแปลกำลังรีสตาร์ต", hint: "" },
  "engine.overloaded": { title: "เอนจินแปลไม่ว่าง", hint: "" },
  "engine.protocol": { title: "เวอร์ชันส่วนขยายไม่ตรงกัน", hint: "โหลดหน้าเว็บใหม่" },
  "engine.internal": { title: "ข้อผิดพลาดภายใน", hint: "ส่งออกบันทึกดีบักจากหน้าตัวเลือก" },
  "msg.too_large": { title: "ข้อมูลใหญ่เกินไป กำลังโหลดใหม่ผ่าน URL", hint: "" },
  "ctx.invalidated": {
    title: "ส่วนขยายเพิ่งถูกโหลดใหม่",
    hint: "โหลดหน้าเว็บใหม่เพื่อแปลต่อ",
  },
  "dnr.failed": { title: "ตั้งค่า Referer ของภาพไม่ได้", hint: "" },
  "store.io": { title: "อ่านหรือเขียนแคชไม่ได้", hint: "" },
  "store.quota": { title: "แคชเต็ม", hint: "ล้างแคชบางส่วนในหน้าตัวเลือก" },
  "site.disabled": { title: "ปิดการแปลสำหรับเว็บไซต์นี้อยู่", hint: "" },
  "privacy.consent": {
    title: "ยังไม่ได้ยืนยันการส่งภาพให้ AI",
    hint: "อ่านประกาศความเป็นส่วนตัวและอนุญาตให้ส่งภาพเพื่อเริ่มแปล",
  },
  cancelled: { title: "ยกเลิกแล้ว", hint: "" },
};

export const TH: Catalog = {
  errors,
  readiness: {
    unknown: { label: "กำลังตรวจสอบ endpoint AI…", hint: "" },
    ready: { label: "Endpoint AI พร้อมใช้งาน", hint: "" },
    unauthorized: { label: "คีย์ API ถูกปฏิเสธ", hint: errors["api.unauthorized"].hint },
    unreachable: { label: "เข้าถึง endpoint AI ไม่ได้", hint: errors["api.unreachable"].hint },
    lna_blocked: { label: "Chrome บล็อกเซิร์ฟเวอร์ AI ภายใน", hint: errors["api.lna_blocked"].hint },
    misconfigured: { label: "ยังไม่ได้ตั้งค่า endpoint AI", hint: errors["api.config"].hint },
  },
  imageState: {
    queued: "อยู่ในคิว",
    acquiring: "กำลังโหลดภาพ",
    detecting: "กำลังหาข้อความ",
    waiting: "รอแปล",
    translating: "กำลังแปล",
    done: "แปลแล้ว",
    "no-text": "ไม่มีข้อความ",
    partial: "แปลบางส่วน",
    refused: "AI ปฏิเสธ",
    paused: "หยุดชั่วคราว",
    error: "ข้อผิดพลาด",
    stale: "คำแปลล้าสมัย",
  },
  unitStatus: {
    pending: "กำลังรอ",
    translating: "กำลังแปล",
    ok: "แปลแล้ว",
    "keep-original": "คงต้นฉบับไว้",
    manual: "แก้ไขแล้ว",
    untranslated: "ยังไม่ได้แปล",
    refused: "AI ปฏิเสธ",
    ignored: "ละเว้น",
    error: "ข้อผิดพลาด",
    stale: "ล้าสมัย",
  },
  enginePhase: {
    booting: "เอนจินแปลกำลังเริ่มทำงาน",
    ready: "เอนจินแปลกำลังทำงาน",
    closing: "เอนจินแปลกำลังหยุด",
    failed: "เอนจินแปลล้มเหลว",
  },
  detectorBackend: { webgpu: "GPU (WebGPU)", wasm: "CPU (WASM)", none: "ยังไม่ได้เลือก" },
  detectorState: { unloaded: "ยังไม่ได้โหลด", loading: "กำลังโหลด", ready: "พร้อม", failed: "ล้มเหลว" },
  detectorCanary: {
    pass: "ตรวจสอบ GPU แล้ว",
    fail: "GPU ให้ผลลัพธ์ไม่สม่ำเสมอ จึงเปลี่ยนไปใช้ CPU แล้ว",
    pending: "กำลังตรวจสอบ GPU",
    skipped: "",
  },
  ui: {
    appName: "Panelingo",
    siteEnable: "แปลเว็บไซต์นี้",
    siteDisable: "หยุดแปลเว็บไซต์นี้",
    modeAuto: "แปลขณะเลื่อนหน้า",
    modeManual: "แปลเมื่อสั่งเท่านั้น",
    translateVisible: "แปลภาพที่มองเห็น",
    translateImage: "แปล",
    retranslate: "แปลอีกครั้ง",
    showOriginal: "แสดงต้นฉบับ",
    uploadsToday: (count: number, mb: number): string =>
      `วันนี้ส่งภาพผสมให้ AI แล้ว ${count} ภาพ (${mb.toFixed(1)} MB)`,
    progress: (done: number, total: number, etaSec?: number): string =>
      etaSec === undefined || !Number.isFinite(etaSec)
        ? `กำลังแปล ${done}/${total}`
        : `กำลังแปล ${done}/${total} · ~${Math.max(1, Math.round(etaSec))} วินาที`,
    privacyTitle: "ก่อนส่งภาพให้ AI",
    privacyBody:
      "ในการแปล ส่วนขยายจะส่งภาพผสมของช่องการ์ตูนที่มีข้อความ (เฉพาะในเว็บไซต์ที่คุณเปิดใช้ หรือเมื่อคุณสั่ง) " +
      "ไปยัง endpoint AI ที่คุณตั้งค่าไว้ ผู้ให้บริการ AI อาจจัดเก็บสิ่งที่ได้รับไว้ตามข้อกำหนดของตน " +
      "โปรดตรวจสอบให้แน่ใจว่าคุณยอมรับเรื่องนี้ได้ ทั้งสำหรับตัวคุณเองและเนื้อหาที่คุณอ่าน",
    privacyAccept: "เข้าใจแล้ว อนุญาตให้ส่ง",
    privacyDecline: "ไม่ส่ง",
  },
  bubble: {
    original: "ต้นฉบับ",
    translation: "คำแปล",
    save: "บันทึก",
    revert: "ใช้คำแปลจาก AI",
    retranslate: "แปลอีกครั้ง",
    close: "ปิด",
    dialog: "กรอบคำพูดที่แปลแล้ว",
    copy: "คัดลอก",
    editLabel: "แก้ไขคำแปล",
    shortened: "ย่อข้อความให้พอดีกับกรอบคำพูด",
    saved: "บันทึกแล้ว",
    retranslating: "กำลังแปลอีกครั้ง…",
  },
  menu: {
    translateImage: "แปลภาพนี้",
    retranslateImage: "แปลภาพนี้อีกครั้ง",
  },
  sidepanel: {
    title: "Panelingo – บทพูด",
    heading: "บทพูด",
    empty: "แท็บนี้ยังไม่มีบทที่แปลแล้ว",
    emptyHint: "เปิดหน้าการ์ตูนบนเว็บไซต์ที่คุณเปิดใช้งาน บทพูดจะปรากฏที่นี่เมื่อแปลเสร็จ",
    refresh: "รีเฟรช",
    copy: "คัดลอกทั้งหมด",
    copied: "คัดลอกไปยังคลิปบอร์ดแล้ว",
    page: (n: number): string => `หน้า ${n}`,
    jump: "แสดง",
    jumpHint: "เลื่อนหน้าไปยังกรอบคำพูดนี้",
    edit: "แก้ไข",
    save: "บันทึก",
    cancel: "ยกเลิก",
    retranslate: "แปลใหม่",
    revert: "เลิกทำการแก้ไข",
    noTranslation: "ไม่มีคำแปล",
    notFound: "กรอบคำพูดนี้ไม่อยู่บนหน้าแล้ว",
    failed: "ไม่สำเร็จ ลองอีกครั้ง",
    types: {
      dialogue: "บทพูด",
      thought: "ความคิด",
      narration: "บรรยาย",
      sign: "ป้าย",
      sfx: "เสียงประกอบ",
      ignore: "ข้าม",
    },
    inconsistent: "ไม่ตรงกับอภิธานศัพท์",
    tabs: { transcript: "บทพูด", glossary: "อภิธานศัพท์" },
    glossary: {
      noSeries: "เปิดหน้าการ์ตูนเพื่อดูอภิธานศัพท์ของซีรีส์นั้น",
      untitled: "ซีรีส์ไม่มีชื่อ",
      states: {
        manual: "รายการของคุณ",
        confirmed: "ยืนยันแล้ว",
        learned: "เรียนรู้แล้ว",
        candidate: "คำแนะนำ",
      },
      hints: {
        manual: "ใช้เสมอ AI จะไม่เปลี่ยนแปลง",
        confirmed: "คำแนะนำที่คุณยอมรับแล้ว ใช้เสมอ",
        learned: "ชื่อและคำศัพท์ที่ AI ใช้ในหลายคำขอ ส่งไปกับทุกคำขอ",
        candidate: "AI พบเพียงครั้งเดียว จะไม่ส่งจนกว่าจะยืนยันหรือพบอีกครั้ง",
      },
      empty: "ยังไม่มีรายการ ชื่อและคำศัพท์จะปรากฏที่นี่เมื่อ AI พบ หรือเพิ่มเองได้",
      original: "ข้อความต้นฉบับ",
      translation: "คำแปล",
      note: "หมายเหตุ (ไม่บังคับ)",
      add: "เพิ่ม",
      delete: "ลบ",
      confirm: "ยืนยัน",
      seen: (count: number): string => `พบ ${count} ครั้ง`,
      incomplete: "กรอกข้อความต้นฉบับและคำแปล",
      profileHeading: "การตั้งค่าซีรีส์",
      sourceLang: "ภาษาต้นฉบับ",
      langAuto: "ตรวจหาอัตโนมัติ",
      langs: {
        ja: "ญี่ปุ่น",
        ko: "เกาหลี",
        zh: "จีน",
        en: "อังกฤษ",
        es: "สเปน",
        other: "อื่นๆ",
      },
      koNames: "ชื่อภาษาเกาหลี",
      koRomanized: "ถอดเป็นอักษรโรมัน (Minjun)",
      koHanViet: "จีน-เวียดนาม (สำหรับคำแปลภาษาเวียดนาม)",
      keepHonorifics: "คงคำยกย่องภาษาญี่ปุ่น (-san, -kun)",
      summary: "ส่งเรื่องย่อที่อัปเดตต่อเนื่อง",
      saveProfile: "บันทึกการตั้งค่า",
      saved: "บันทึกแล้ว",
      export: "ส่งออก",
      import: "นำเข้า",
      imported: (count: number): string => `นำเข้า ${count} รายการแล้ว`,
      importFailed: "ไฟล์นี้ไม่ใช่อภิธานศัพท์ของ Panelingo",
    },
  },
  debug: { heading: "ดีบัก (เฉพาะบิลด์ dev/test)" },
  duration: (ms: number): string => {
    const seconds = Math.round(Math.abs(ms) / 1000);
    if (seconds < 60) return `${seconds} วินาที`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} นาที`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} ชั่วโมง`;
    return `${Math.round(hours / 24)} วัน`;
  },
  popup: {
    openTranscript: "เปิดบทพูดทั้งหมด",
    cookies: "ส่งคุกกี้เมื่อโหลดรูปภาพ",
    cookiesHint:
      "สำหรับเว็บไซต์ที่แสดงรูปภาพเฉพาะผู้อ่านที่เข้าสู่ระบบ คุกกี้จะถูกส่งไปยังเซิร์ฟเวอร์รูปภาพเท่านั้น ไม่ส่งไปยัง AI",
    apiHeading: "Endpoint AI",
    engineHeading: "เอนจินแปล",
    siteHeading: "เว็บไซต์นี้",
    checking: "กำลังตรวจสอบ…",
    model: (model: string): string => `โมเดล: ${model}`,
    endpoint: (url: string): string => `Endpoint: ${url}`,
    cause: (cause: string): string => `รายละเอียด: ${cause}`,
    engineStopped: "เอนจินแปลว่างอยู่ และจะเริ่มทำงานเมื่อคุณสั่งแปล",
    engineUnreadable: "อ่านสถานะเอนจินแปลไม่ได้",
    detectorLine: (backend: string, state: string, canary: string): string =>
      `การตรวจจับข้อความ: ${backend}, ${state}${canary === "" ? "" : ` (${canary})`}`,
    queueLine: (queued: number, inFlight: number, done: number, failed: number): string =>
      `คิว: รอ ${queued} · กำลังส่ง ${inFlight} · เสร็จ ${done} · ล้มเหลว ${failed}`,
    pausedBy: (title: string): string => `หยุดชั่วคราว: ${title}`,
    siteUnsupported: "แปลหน้านี้ไม่ได้ (รองรับเฉพาะหน้า http/https)",
    siteOn: "เปิดการแปลสำหรับเว็บไซต์นี้อยู่",
    siteOff: "ปิดการแปลสำหรับเว็บไซต์นี้อยู่",
    modeLabel: "โหมด",
    visibleSent: (count: number): string =>
      count > 0 ? `ส่งภาพไปแปลแล้ว ${count} ภาพ` : "ไม่พบภาพการ์ตูนที่มองเห็นอยู่",
    visibleUnavailable: "ส่วนขยายทำงานในหน้านี้ไม่ได้",
    retranslatePage: "แปลหน้านี้อีกครั้ง",
    retranslateQueued: (count: number): string => `นำบอลลูนคำพูด ${count} อันเข้าคิวแปลอีกครั้งแล้ว`,
    actionFailed: (title: string): string => `ดำเนินการไม่สำเร็จ: ${title}`,
    privacyDetails: "ดูสิ่งที่ถูกส่งไป",
    options: "ตัวเลือก",
    setupHint: "ตั้งค่า endpoint AI ของคุณ (Base URL, คีย์ API, โมเดล) ในหน้าตัวเลือกเพื่อเริ่มใช้งาน",
    consentHint: "คลิกไอคอน Panelingo เพื่ออ่านประกาศความเป็นส่วนตัวก่อนเปิดการแปลที่นี่",
    build: (id: string): string => `บิลด์ ${id}`,
  },
  options: {
    exportLog: "ส่งออกบันทึกการดีบัก",
    exportFailed: "ไม่สามารถส่งออกบันทึกการดีบักได้",
    exportEmpty: "บันทึกการดีบักว่างเปล่า",
    title: "ตัวเลือก",
    apiHeading: "Endpoint AI (ที่รองรับ OpenAI)",
    apiIntro:
      "ใช้ได้กับทุกบริการที่รองรับ API chat completions ของ OpenAI และรับภาพได้ ได้แก่ OpenAI, OpenRouter, " +
      "Azure OpenAI, Google Gemini (โหมด OpenAI) หรือเซิร์ฟเวอร์ภายใน เช่น Ollama, LM Studio, vLLM หรือ LiteLLM",
    preset: "พรีเซ็ต",
    presetCustom: "กำหนดเอง",
    baseUrl: "Base URL",
    baseUrlHint: "รวมพาธเวอร์ชันด้วย เช่น https://api.openai.com/v1 หรือ http://127.0.0.1:11434/v1",
    baseUrlInvalid: "URL http(s) ไม่ถูกต้อง",
    apiKey: "คีย์ API",
    apiKeyHint:
      "จัดเก็บไว้ในโปรไฟล์เบราว์เซอร์นี้เท่านั้น เว้นว่างไว้ได้สำหรับเซิร์ฟเวอร์ภายในที่ไม่ต้องใช้คีย์",
    model: "โมเดล",
    modelHint: "โมเดลต้องรับภาพเป็นอินพุตได้ (vision) เช่น gpt-4o-mini, gemini-2.5-flash, qwen2.5-vl",
    modelInvalid: "ป้อน ID โมเดล",
    testConnection: "ทดสอบการเชื่อมต่อ",
    testing: "กำลังทดสอบ…",
    testOk: (detail: string): string => `เชื่อมต่อแล้ว ${detail}`,
    testFailed: (detail: string): string => `ล้มเหลว: ${detail}`,
    concurrency: "จำนวนคำขอแปลพร้อมกัน",
    concurrencyHint: "ค่าเริ่มต้น 2 และสูงสุด 4 ลดค่านี้ลงหากผู้ให้บริการจำกัดอัตราคำขอของคุณ",
    concurrencyInvalid: "เลือกตัวเลขตั้งแต่ 1 ถึง 4",
    languageHeading: "ภาษา",
    uiLanguage: "ภาษาของอินเทอร์เฟซ",
    targetLanguage: "แปลเป็น",
    languageAuto: "ตามเบราว์เซอร์",
    save: "บันทึก",
    saved: "บันทึกแล้ว",
    saveFailed: "บันทึกไม่ได้",
    sitesHeading: "เว็บไซต์",
    sitesEmpty: "ยังไม่มีเว็บไซต์ เปิดหน้าการ์ตูน คลิกไอคอนส่วนขยาย แล้วเปิดการแปลสำหรับเว็บไซต์นั้น",
    siteEnabled: "เปิด",
    siteMode: "โหมด",
    siteRemove: "นำออก",
    privacyHeading: "ความเป็นส่วนตัว: สิ่งที่ถูกส่งให้ AI",
    privacyPoints: [
      "ในการแปลแต่ละครั้ง ส่วนขยายจะส่งภาพผสม JPEG หนึ่งภาพไปยัง endpoint AI ที่คุณตั้งค่าไว้ ซึ่งประกอบด้วย" +
        "ภาพขนาดย่อของภาพต้นฉบับ (หรือชิ้นส่วนเว็บตูน) ที่มีข้อความ กรอบหมายเลขรอบบริเวณข้อความแต่ละจุด " +
        "และภาพขยายของบริเวณเหล่านั้น",
      "ข้อความที่ส่งไปด้วย: กฎการจัดรูปแบบและภาษา อภิธานศัพท์ของเรื่อง (สูงสุด 60 รายการ) " +
        "บทพูดก่อนหน้าในตอนเดียวกันสูงสุด 20 บรรทัด และสรุปสั้นๆ",
      "ไม่ส่งเด็ดขาด: ภาพที่ไม่มีข้อความ ที่อยู่ของหน้าที่คุณอ่าน คุกกี้ ที่อยู่ IP ของคุณ หรือเฮดเดอร์ของเบราว์เซอร์ " +
        "(นอกเหนือจากที่คำขอใดๆ ไปยัง endpoint ของคุณมีอยู่แล้ว)",
      "ผู้ให้บริการ AI อาจเก็บสิ่งที่ได้รับไว้ตามข้อกำหนดของตน ให้ถือว่าทุกอย่างที่ส่งไปถูกจัดเก็บไว้แล้ว",
      "เฉพาะเว็บไซต์ที่คุณเปิดใช้เท่านั้นที่จะแปลขณะเลื่อนหน้า หน้าอื่นจะแปลเมื่อคุณสั่งเท่านั้น " +
        "(ผ่านเมนูคลิกขวาหรือแป้นพิมพ์ลัด) และส่วนขยายจะถามคุณก่อนการอัปโหลดครั้งแรกเสมอ",
      "ป๊อปอัปจะแสดงจำนวนภาพผสมที่ส่งไปในวันนี้",
      "บนอุปกรณ์นี้ คำแปล ตำแหน่งบอลลูนคำพูด และแพตช์ลบข้อความจะเก็บอยู่ใน IndexedDB ของส่วนขยาย " +
        "ล้างได้ในส่วนแคชด้านล่าง",
    ],
    privacyAcked: (when: string): string => `คุณยืนยันประกาศการส่งภาพแล้วเมื่อ ${when}`,
    privacyNotAcked: "คุณยังไม่ได้ยืนยันประกาศการส่งภาพ ส่วนขยายจะถามก่อนการอัปโหลดครั้งแรก",
    cacheHeading: "แคช",
    cacheHint:
      "ลบคำแปล ตำแหน่งบอลลูนคำพูด และแพตช์ลบข้อความทั้งหมดที่เก็บไว้ในอุปกรณ์นี้ " +
      "เมื่ออ่านอีกครั้งจะต้องแปล (และส่งภาพ) ใหม่",
    cacheClear: "ล้างแคชทั้งหมด",
    cacheConfirm: "ล้างแคชทั้งหมดใช่ไหม การอ่านครั้งถัดไปจะต้องแปลและส่งภาพใหม่อีกครั้ง",
    cacheCleared: (count: number): string => `ลบแล้ว ${count} รายการ`,
    cacheFailed: (title: string): string => `ล้างแคชไม่ได้: ${title}`,
    debugHeading: "บันทึกดีบัก",
    logLevel: "ระดับบันทึก",
    logLevels: {
      debug: "ละเอียด (debug)",
      info: "ข้อมูล",
      warn: "คำเตือน",
      error: "ข้อผิดพลาดเท่านั้น",
    },
  },
  optionsAdvanced: {
    heading: "การตั้งค่าขั้นสูง",
    intro:
      "ปรับแต่งคำขอ การตรวจจับข้อความ การวางข้อความแปล และแคชอย่างละเอียด " +
      "ค่าเริ่มต้นเหมาะกับการใช้งานส่วนใหญ่ การเปลี่ยนแปลงแต่ละรายการจะบันทึกเมื่อคุณออกจากช่องกรอก",
    defaultIs: (value: string): string => `ค่าเริ่มต้น: ${value}`,
    range: (min: string, max: string): string => `ค่าที่ใช้ได้: ${min} ถึง ${max}`,
    automatic: "อัตโนมัติ",
    on: "เปิด",
    off: "ปิด",
    reset: "รีเซ็ต",
    resetLabel: (label: string): string => `รีเซ็ต “${label}” เป็นค่าเริ่มต้น`,
    resetAll: "รีเซ็ตการตั้งค่าขั้นสูงทั้งหมด",
    resetAllConfirm: "รีเซ็ตการตั้งค่าขั้นสูงทั้งหมดเป็นค่าเริ่มต้นใช่ไหม",
    resetAllDone: "การตั้งค่าขั้นสูงทั้งหมดกลับเป็นค่าเริ่มต้นแล้ว",
    notANumber: "ป้อนตัวเลข",
    adjusted: (value: string): string => `บันทึกเป็น ${value} ซึ่งเป็นค่าที่ใช้ได้ที่ใกล้เคียงที่สุด`,
    badKey: "ใช้รหัสปุ่ม เช่น Backquote หรือ KeyH หรือเว้นว่างไว้",
    verticalChoices: { auto: "อัตโนมัติ", never: "ไม่ใช้" },
    groups: {
      api: "คำขอไปยัง AI",
      translate: "เนื้อหาคำขอ",
      detector: "การตรวจจับข้อความ",
      engine: "เอนจินแปล",
      discovery: "การค้นหาภาพ",
      render: "การแสดงคำแปล",
      memory: "ความจำของซีรีส์",
      cache: "แคช",
      privacy: "ขีดจำกัดของภาพ",
      debug: "บันทึกดีบัก",
    },
    fields: {
      "api.temperature": {
        label: "อุณหภูมิ (temperature)",
        hint: "ความหลากหลายของคำตอบ เว้นว่างไว้เพื่อใช้ค่าเริ่มต้นของผู้ให้บริการ",
      },
      "api.urgentLane": {
        label: "ช่องทางเพิ่มสำหรับภาพบนหน้าจอ",
        hint: "เพิ่มช่องทางคำขออีกหนึ่งช่องที่สงวนไว้สำหรับภาพที่คุณกำลังดูอยู่",
      },
      "api.maxInFlight": {
        label: "จำนวนคำขอพร้อมกันสูงสุด",
        hint: "ขีดจำกัดตายตัวที่รวมช่องทางเพิ่มแล้ว และจะไม่ต่ำกว่าจำนวนคำขอแปลพร้อมกัน",
      },
      "api.firstByteTimeoutMs": {
        label: "รอการตอบกลับแรก (วินาที)",
        hint: "เลิกรอเมื่อ endpoint ไม่ส่งอะไรมาเลยนานเท่านี้",
      },
      "api.idleTimeoutMs": {
        label: "หมดเวลาเมื่อคำตอบค้าง (วินาที)",
        hint: "เลิกรอเมื่อคำตอบหยุดสตรีมนานเท่านี้",
      },
      "api.totalTimeoutMs": {
        label: "เวลาสูงสุดต่อคำขอ (วินาที)",
        hint: "ยกเลิกคำขอใดๆ ที่ใช้เวลานานกว่านี้",
      },
      "api.healthTimeoutMs": {
        label: "หมดเวลาการตรวจสอบการเชื่อมต่อ (วินาที)",
        hint: "ใช้กับการตรวจสอบ endpoint และปุ่มทดสอบการเชื่อมต่อ",
      },
      "translate.boxBudget": {
        label: "จำนวนบริเวณข้อความต่อคำขอ",
        hint: "เว้นว่างไว้เพื่อใช้ตามโปรไฟล์ของโมเดล (12, 16 หรือ 20)",
      },
      "translate.jpegQuality": {
        label: "คุณภาพ JPEG",
        hint: "คุณภาพของภาพผสมที่ส่งให้ AI",
      },
      "translate.requestBodyCapMb": {
        label: "ขนาดคำขอสูงสุด (MB)",
        hint: "ภาพผสมที่ใหญ่กว่านี้จะถูกบีบอัดมากขึ้น แล้วจึงแบ่งส่วน",
      },
      "translate.promptCharCap": {
        label: "ความยาวพรอมต์สูงสุด (อักขระ)",
        hint: "เมื่อคำขอยาวกว่านี้ จะย่อบริบทให้สั้นลงก่อน",
      },
      "translate.maxLadderRequestsPerPack": {
        label: "คำขอเพิ่มเติมเพื่อกู้ข้อความที่ตกหล่น",
        hint: "ถามซ้ำและแบ่งคำขอเมื่อ AI ข้ามบริเวณข้อความ",
      },
      "translate.maxHttpRetriesPerRequest": {
        label: "จำนวนครั้งที่ลองใหม่เมื่อเครือข่ายผิดพลาด",
        hint: "ต่อคำขอ สำหรับความล้มเหลวชั่วคราวของ HTTP และเครือข่าย",
      },
      "translate.splitOnRefusal": {
        label: "แบ่งคำขอที่ถูกปฏิเสธ",
        hint: "เมื่อ AI ปฏิเสธ ให้ลองส่งสองครึ่งแยกกันแทนการยอมแพ้",
      },
      "detector.backend": {
        label: "ฮาร์ดแวร์สำหรับการตรวจจับ",
        hint: "อัตโนมัติจะใช้ GPU เมื่อผ่านการทดสอบตัวเอง ไม่เช่นนั้นจะใช้ CPU",
      },
      "detector.scoreMin": {
        label: "คะแนนการตรวจจับขั้นต่ำ",
        hint: "ค่าที่ต่ำลงจะพบข้อความมากขึ้น และตรวจจับผิดมากขึ้นด้วย",
      },
      "detector.sliceTriggerRatio": {
        label: "แบ่งภาพที่ยาวกว่า (อัตราส่วน)",
        hint: "ภาพและแถบเว็บตูนที่ด้านยาวเกินด้านสั้นตามจำนวนเท่านี้จะถูกตัดเป็นชิ้น",
      },
      "detector.sliceHeightRatio": {
        label: "ความยาวชิ้น (× ด้านสั้น)",
        hint: "ความยาวของแต่ละชิ้นเป็นจำนวนเท่าของด้านสั้นของภาพ",
      },
      "detector.sliceOverlap": {
        label: "การซ้อนทับของชิ้น (สัดส่วน)",
        hint: "ส่วนที่ชิ้นซึ่งอยู่ติดกันซ้อนทับกัน คิดเป็นสัดส่วนของหนึ่งชิ้น",
      },
      "detector.sliceOverlapMinPx": {
        label: "การซ้อนทับของชิ้นขั้นต่ำ (พิกเซล)",
        hint: "ชิ้นที่อยู่ติดกันจะซ้อนทับกันอย่างน้อยเท่านี้พิกเซลเสมอ",
      },
      "detector.quietRows": {
        label: "ตัดชิ้นระหว่างแถวข้อความ",
        hint: "ทดลอง: ย้ายจุดตัดชิ้นไปยังแถวที่ไม่มีหมึก",
      },
      "engine.idleCloseMin": {
        label: "ปิดเอนจินที่ว่างอยู่หลังจาก (นาที)",
        hint: "คืนหน่วยความจำเมื่อไม่มีหน้าใดใช้เอนจินนานเท่านี้",
      },
      "engine.detectorReleaseMin": {
        label: "เลิกโหลดการตรวจจับข้อความหลังจาก (นาที)",
        hint: "ปล่อยโมเดลตรวจจับเมื่อไม่ได้ทำงานนานเท่านี้",
      },
      "engine.portIdleMin": {
        label: "ตัดการเชื่อมต่อหน้าที่ว่างอยู่หลังจาก (นาที)",
        hint: "หน้าเว็บจะปล่อยเอนจินหลังจากไม่มีงานนานเท่านี้",
      },
      "discovery.minNaturalSide": {
        label: "ข้ามภาพที่เล็กกว่า (พิกเซล)",
        hint: "ขนาดจริงของด้านสั้น ใช้ข้ามไอคอน รูปโปรไฟล์ และโฆษณา",
      },
      "discovery.minDisplayedSide": {
        label: "ข้ามภาพที่แสดงเล็กกว่า (พิกเซล)",
        hint: "ขนาดของด้านสั้นบนหน้าจอ",
      },
      "discovery.secondsPerScreenDefault": {
        label: "ความเร็วในการอ่านเริ่มต้น (วินาทีต่อหน้าจอ)",
        hint: "ค่าประมาณเริ่มต้นจนกว่าจะวัดความเร็วในการอ่านของคุณได้",
      },
      "discovery.lookaheadMinScreens": {
        label: "แปลล่วงหน้า ขั้นต่ำ (หน้าจอ)",
        hint: "ภาพที่อยู่ต่ำกว่ามุมมองในระยะนี้จะถูกแปลก่อนที่คุณจะไปถึงเสมอ",
      },
      "discovery.lookaheadMaxScreens": {
        label: "แปลล่วงหน้า สูงสุด (หน้าจอ)",
        hint: "ขีดจำกัดบนเมื่อคุณอ่านเร็วหรือ AI ตอบช้า",
      },
      "discovery.lookaheadMaxScreensStrip": {
        label: "แปลล่วงหน้าในเว็บตูนแนวยาว สูงสุด (หน้าจอ)",
        hint: "ขีดจำกัดบนสำหรับภาพแนวตั้งที่ยาว",
      },
      "discovery.detectAheadMinScreens": {
        label: "ตรวจจับล่วงหน้า ขั้นต่ำ (หน้าจอ)",
        hint: "ภาพที่หน้าเว็บยังไม่ได้โหลดจะถูกตรวจจับล่วงหน้าในระยะนี้ (ไม่มีการอัปโหลด)",
      },
      "discovery.detectAheadMaxScreens": {
        label: "ตรวจจับล่วงหน้า สูงสุด (หน้าจอ)",
        hint: "ขีดจำกัดบนสำหรับผู้ที่อ่านเร็ว",
      },
      "discovery.detectMaxImages": {
        label: "จำนวนภาพที่ตรวจจับล่วงหน้าสูงสุด",
        hint: "นับทุกภาพที่อยู่ข้างหน้า ไม่ว่าจะโหลดแล้วหรือยัง",
      },
      "discovery.fetchPerHostConcurrency": {
        label: "จำนวนการดาวน์โหลดภาพพร้อมกันต่อเซิร์ฟเวอร์",
        hint: "จำนวนภาพที่ดาวน์โหลดพร้อมกันจากเซิร์ฟเวอร์รูปภาพเดียวกัน",
      },
      "discovery.prefetchSpacingMs": {
        label: "ช่วงพักระหว่างการดาวน์โหลดภาพ (มิลลิวินาที)",
        hint: "เวลาขั้นต่ำระหว่างการดาวน์โหลดสองครั้งจากเซิร์ฟเวอร์เดียวกัน",
      },
      "discovery.scrollDebounceMs": {
        label: "หน่วงเวลาตอบสนองการเลื่อน (มิลลิวินาที)",
        hint: "รอนานเท่านี้หลังเลื่อนหน้า ก่อนจัดลำดับงานใหม่",
      },
      "discovery.mutationDebounceMs": {
        label: "หน่วงเวลาตอบสนองเมื่อหน้าเปลี่ยน (มิลลิวินาที)",
        hint: "รอนานเท่านี้หลังหน้าเว็บเปลี่ยน (การโหลดแบบ lazy, แอปอ่านการ์ตูน) ก่อนค้นหาภาพใหม่",
      },
      "discovery.stripGapPx": {
        label: "ช่องว่างสูงสุดภายในแถบเว็บตูน (พิกเซล)",
        hint: "ภาพที่อยู่ใกล้กันกว่านี้จะรวมเป็นแถบต่อเนื่องเดียว",
      },
      "discovery.translateHiddenTabs": {
        label: "แปลในแท็บพื้นหลัง",
        hint: "ปิด: โหมดอัตโนมัติจะรอจนกว่าแท็บจะเคยถูกแสดง",
      },
      "render.font": {
        label: "ฟอนต์บทพูด",
        hint: "ฟอนต์ของข้อความแปลในบอลลูนคำพูด",
      },
      "render.verticalText": {
        label: "ข้อความแนวตั้ง",
        hint: "คำแปลภาษาญี่ปุ่นหรือจีนตัวเต็มจะเขียนจากบนลงล่างในกรอบคำพูดแนวตั้ง เลือก “ไม่ใช้” เพื่อให้คำแปลทั้งหมดเป็นแนวนอน",
      },
      "render.minFontPx": {
        label: "ขนาดตัวอักษรเล็กสุด (พิกเซล)",
        hint: "ข้อความที่ใส่ไม่พอดีที่ขนาดนี้จะถูกย่อด้วย “…”",
      },
      "render.maxFontPx": {
        label: "ขนาดตัวอักษรใหญ่สุด (พิกเซล)",
        hint: "ข้อความจะคงขนาดใกล้เคียงกับตัวอักษรต้นฉบับด้วย",
      },
      "render.eraseSfx": {
        label: "ลบเสียงประกอบ",
        hint: "ลบเสียงประกอบออกจากภาพแทนการติดป้ายกำกับ",
      },
      "render.sfxLabels": {
        label: "ติดป้ายเสียงประกอบ",
        hint: "แสดงคำแปลของเสียงประกอบเป็นป้ายเล็กๆ",
      },
      "render.showDoneBadge": {
        label: "ทำเครื่องหมายภาพที่แปลแล้ว",
        hint: "แสดงตราเล็กๆ บนภาพที่แปลแล้วทุกภาพ",
      },
      "render.peekKey": {
        label: "กดค้างเพื่อดูต้นฉบับ (รหัสปุ่ม)",
        hint: "รหัสปุ่ม เช่น Backquote หรือ KeyH เว้นว่างไว้เพื่อปิด",
      },
      "render.peekWithAlt": {
        label: "แสดงต้นฉบับขณะกด Alt ค้างด้วย",
        hint: "การกดปุ่ม Alt ค้างอย่างเดียวก็ซ่อนคำแปลได้เช่นกัน",
      },
      "render.popupWithAltClick": {
        label: "Alt+คลิกเพื่อเปิดป๊อปอัปของบอลลูน",
        hint: "ป๊อปอัปแสดงต้นฉบับและให้แก้ไขคำแปลได้ การกดค้างจะเปิดได้เสมอ",
      },
      "memory.enabled": {
        label: "ใช้ความจำของซีรีส์",
        hint: "ส่งอภิธานศัพท์ บทพูดก่อนหน้า และเรื่องย่อไปกับทุกคำขอ และเรียนรู้ชื่อจากคำตอบ",
      },
      "memory.glossaryInPrompt": {
        label: "จำนวนรายการอภิธานศัพท์ต่อคำขอ",
        hint: "รายการของคุณก่อน ตามด้วยรายการที่ยืนยันแล้ว แล้วจึงเป็นรายการที่เรียนรู้",
      },
      "memory.termMinSightings": {
        label: "จำนวนครั้งที่พบก่อนเรียนรู้คำศัพท์",
        hint: "จำนวนคำขอที่แตกต่างกันซึ่งต้องพบคำศัพท์ก่อนจะส่งคำนั้นไป",
      },
      "memory.historyMaxLines": {
        label: "บทพูดก่อนหน้าที่ส่งเป็นบริบท",
        hint: "บทพูดจากตอนเดียวกัน 0 คือไม่ส่งเลย",
      },
      "memory.historyMaxTokens": {
        label: "งบประมาณโทเค็นสำหรับบทพูดก่อนหน้า",
        hint: "บทพูดที่เก่าที่สุดจะถูกตัดออกก่อน",
      },
      "memory.summaryMaxWords": {
        label: "ความยาวเรื่องย่อ (คำ)",
        hint: "0 คือปิดเรื่องย่อที่อัปเดตต่อเนื่อง",
      },
      "cache.translationTtlDays": {
        label: "เก็บคำแปลที่ไม่ได้ใช้ไว้ (วัน)",
        hint: "การแก้ไขของคุณเองจะไม่มีวันหมดอายุ",
      },
      "cache.encodedBytesLruMb": {
        label: "แคชภาพที่ดาวน์โหลด (MB)",
        hint: "หน่วยความจำที่เอนจินใช้เก็บภาพที่ดาวน์โหลดแล้ว",
      },
      "privacy.maxImageBytes": {
        label: "ไฟล์ภาพใหญ่สุด (MiB)",
        hint: "ไฟล์ภาพที่ใหญ่กว่านี้จะถูกข้าม",
      },
      "privacy.maxImagePixels": {
        label: "ภาพใหญ่สุด (ล้านพิกเซล)",
        hint: "ภาพที่มีพิกเซลมากกว่านี้จะถูกข้าม",
      },
      "debug.logCapacity": {
        label: "จำนวนรายการบันทึกที่เก็บไว้",
        hint: "ขนาดของบันทึกดีบักที่เอนจินจัดเก็บ",
      },
    },
    site: {
      settings: "การตั้งค่า",
      settingsFor: (site: string): string => `การตั้งค่าสำหรับ ${site}`,
      layout: "เลย์เอาต์และทิศทางการอ่าน",
      layouts: {
        auto: "ตรวจหาอัตโนมัติ",
        webtoon: "เว็บตูน (แถบแนวตั้ง)",
        "paged-rtl": "แบบหน้า ขวาไปซ้าย (มังงะ)",
        "paged-ltr": "แบบหน้า ซ้ายไปขวา (คอมิก)",
      },
      sourceLangHint: "เลือกคำสั่งเฉพาะภาษาสำหรับ AI และกำหนดว่าจะขยายภาพตัดข้อความมากเพียงใด",
      referer: "Referer สำหรับการดาวน์โหลดภาพ",
      referers: {
        auto: "อัตโนมัติ",
        "page-url": "ที่อยู่หน้าเว็บแบบเต็ม",
        origin: "เฉพาะที่อยู่เว็บไซต์",
      },
      refererHint:
        "อัตโนมัติจะใช้ตามหน้าเว็บ แล้วลองใหม่ด้วยที่อยู่หน้าเว็บแบบเต็มหากเซิร์ฟเวอร์รูปภาพปฏิเสธ " +
        "เปลี่ยนค่านี้เฉพาะเมื่อโหลดภาพไม่ขึ้น",
      subdomains: "ใช้กับโดเมนย่อยด้วย",
      subdomainsHint: "แปลในทุกโดเมนย่อยของเว็บไซต์นี้ด้วยการตั้งค่าเดียวกัน",
      prefetch: "เตรียมภาพล่วงหน้า",
      prefetchHint:
        "ตรวจจับภาพที่อยู่ต่ำกว่ามุมมองซึ่งหน้าเว็บยังไม่ได้โหลด เพื่อให้พร้อมเมื่อคุณไปถึง จะไม่อัปโหลดอะไรจนกว่าภาพจะอยู่ใกล้",
      frames: "เฟรมโปรแกรมอ่านจากเว็บไซต์อื่น",
      framesHint:
        "หนึ่ง origin ต่อบรรทัด เช่น https://viewer.example.com " +
        "เมื่อหน้าการ์ตูนแสดงอยู่ในเฟรมที่มาจากเว็บไซต์อื่น",
      framesInvalid: (lines: string): string => `ไม่ใช่ origin แบบ http(s): ${lines}`,
    },
    transfer: {
      heading: "สำรองและกู้คืน",
      hint:
        "บันทึกการตั้งค่าและรายการเว็บไซต์ของคุณเป็นไฟล์ JSON หรือโหลดจากไฟล์ดังกล่าว " +
        "การยืนยันความเป็นส่วนตัวจะไม่ถูกส่งออก",
      includeKey: "รวมคีย์ API",
      includeKeyHint: "ปิดตัวเลือกนี้ไว้ก่อนแชร์ไฟล์ เพราะใครก็อ่านคีย์ในไฟล์ได้",
      export: "ส่งออกการตั้งค่า",
      import: "นำเข้าการตั้งค่า",
      importConfirm: "แทนที่การตั้งค่าของคุณด้วยการตั้งค่าในไฟล์ใช่ไหม เว็บไซต์ในไฟล์จะถูกเพิ่มหรืออัปเดต",
      notJson: "ไฟล์นี้ไม่ใช่ JSON ที่ถูกต้อง",
      notSettings: "ไฟล์นี้ไม่ใช่ไฟล์ส่งออกการตั้งค่าของ Panelingo",
      tooNew: "ไฟล์นี้สร้างโดย Panelingo เวอร์ชันที่ใหม่กว่า",
      imported: (settings: number, sites: number): string =>
        `นำเข้าแล้ว การตั้งค่าที่เปลี่ยน: ${settings} เว็บไซต์: ${sites}`,
      keyImported: "นำเข้าคีย์ API จากไฟล์แล้ว",
      keyKept: "เก็บคีย์ API ของคุณไว้ตามเดิม (ไฟล์ไม่มีคีย์)",
    },
  },
  manifest: {
    description: "แปลการ์ตูน มังงะ และเว็บตูนบนหน้าเว็บโดยตรงขณะอ่าน ด้วย AI ใดก็ได้ที่รองรับ OpenAI",
    commands: {
      "toggle-overlay": "แสดงหรือซ่อนเลเยอร์คำแปล",
      "translate-visible": "แปลภาพที่มองเห็น",
      "toggle-site": "เปิดหรือปิดการแปลอัตโนมัติสำหรับเว็บไซต์นี้",
      "open-side-panel": "เปิดแผงบทพูดด้านข้าง",
    },
  },
};
