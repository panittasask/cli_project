# แผนปรับปรุง Local AI CLI

บันทึกเมื่อ: 2026-07-14

## เป้าหมาย

ทำให้ CLI ตอบคำถามทั่วไปได้ถูกต้อง ใช้เครื่องมือเฉพาะเมื่อจำเป็น ไม่สับสน
บริบทระหว่างงาน ค้นเว็บจากหลักฐานที่เกี่ยวข้อง และตรวจสอบผลการแก้ไฟล์ก่อนรายงาน
ว่าสำเร็จ

## สถานะปัจจุบัน

- `npm run dev` เลือกโมเดล เปิด llama-server และเข้า CLI ใน terminal เดียว
- ค่าเริ่มต้นเป็น Agent mode
- MCP client แบบ stdio ใช้งานได้
- มี MCP `example.echo` และ `web-search.search_web`
- Web search ใช้ DuckDuckGo และ Bing RSS fallback
- ปัญหาที่พบ:
  - โมเดลตอบความรู้พื้นฐานผิด เช่น อธิบายนกฮูกเป็นนกทะเล
  - ผลค้นหาที่ไม่เกี่ยวข้องถูกนำมาแต่งคำตอบ
  - history จากงานก่อนหน้ารบกวนคำถามใหม่
  - system prompt เรื่อง coding/MCP รบกวนคำถามทั่วไป
  - งานแก้ไฟล์ไม่มี validator ก่อนรายงานว่าสำเร็จ
  - `.gitignore` ปัจจุบันผิดและ `node_modules` ถูก track แล้ว 6,961 ไฟล์

## สถานะล่าสุด (2026-07-15)

- หัวข้อ 1 เสร็จแล้ว: แก้ `.gitignore` และนำ generated files ออกจาก Git index
- หัวข้อ 2 เสร็จแล้ว: เพิ่ม `npm run baseline:model` และทดสอบ GGUF 4 ตัว
  โดยพบว่า Qwen2.5-Coder-7B ตอบความรู้พื้นฐานผิดแม้ไม่มี Agent/history
- หัวข้อ 3 เสร็จแล้ว: แยก sampling สำหรับ chat, planner และ agent action
  พร้อม environment override; Qwythos-9B ผ่าน action probe ซ้ำ 5/5
- หัวข้อ 4 ทำส่วนสำคัญแล้ว: เพิ่ม `/clear` และลด default history เหลือ 6 ข้อความ
  โดยไม่ลบ session ถาวร; history summarization ยังไม่ได้ทำ
- หัวข้อ 6 เสร็จแล้ว: เพิ่ม `/debug on|off`, decision summary, redacted JSONL trace
  และ offline regression test
- โมเดลแนะนำปัจจุบัน: `Qwythos-9B-Claude-Mythos-5-1M-MTP-Q8_0.gguf`
  เพราะ direct baseline ไม่แต่งคำตอบ Meme 67 และ agent protocol เลือก `read_file`
  ถูกต้องคงที่ 5/5

## ลำดับงานพรุ่งนี้

### 1. แก้ Git hygiene ก่อน

- แก้ `.gitignore` ไม่ให้ ignore ตัวเอง, `.cli/mcp.json` และ `mcp/servers/`
- ignore `.cli-sessions.json`, `.cli/logs/`, `node_modules/`, `.env*`, build output
- นำ generated files ออกจาก Git index โดยไม่ลบไฟล์ในเครื่อง
- ตรวจด้วย `git check-ignore`, `git status --ignored` และ `git ls-files`

เกณฑ์ผ่าน:

- `.gitignore`, MCP config และ MCP source ถูก track
- `node_modules`, session data และ logs ไม่ถูก track

### 2. ทำ baseline test แยกโมเดลออกจาก Agent

- ตรวจ metadata ของ GGUF ว่าเป็น Instruct/Chat model ไม่ใช่ Base model
- ตรวจ embedded chat template และ template ที่ llama.cpp ใช้
- ทดสอบคำถามชุดเดียวกันแบบ direct API โดยไม่มี history และไม่มี tools
- เปรียบเทียบอย่างน้อย:
  - `นกฮูกคืออะไร`
  - `Meme 67 คืออะไร`
  - `session ของ CLI เก็บที่ไหน`
- บันทึก model, quantization, prompt, sampling และผลลัพธ์

เกณฑ์ผ่าน:

- ระบุได้ว่าความผิดพื้นฐานมาจากโมเดล/template หรือ orchestration
- ถ้า direct API ยังตอบผิด ให้ทดลองโมเดล Instruct ตัวอื่นก่อนแก้ prompt เพิ่ม

### 3. กำหนด sampling ให้แน่นอน

- เพิ่ม config กลางสำหรับ `temperature`, `top_p`, `top_k`, `repeat_penalty`, `max_tokens`
- ใช้ค่าค่อนข้าง deterministic สำหรับ router/tool calling เช่น temperature `0.1`
- แยกค่าของ chat ปกติออกจาก planner/router/agent action
- เปิดให้ override ด้วย environment variables

เกณฑ์ผ่าน:

- รันคำถาม/action เดิมซ้ำ 5 ครั้งแล้วรูปแบบ JSON และ tool selection คงที่

### 4. แยก context ตามประเภทงาน

- เพิ่ม `/clear` สำหรับเริ่ม task ใหม่โดยไม่ลบ session ถาวร
- ลดการส่ง history แบบตายตัว 10 ข้อความ
- แยก current task context ออกจาก long-term session history
- ไม่ส่งบทสนทนาเรื่อง search/coding ไปยังคำถามใหม่ที่ไม่เกี่ยวข้อง
- พิจารณาสรุป history แทนการส่งข้อความดิบทั้งหมด

เกณฑ์ผ่าน:

- หลังทำงาน `.gitignore` แล้วถามเรื่อง session ต้องไม่พูดถึง server หรือ MCP creation

### 5. แยก system prompt และ router

- สร้าง prompt แยกสำหรับ:
  - general chat
  - web research
  - coding/file edit
  - MCP creation
- อย่าใส่กฎสร้าง MCP server ในทุกคำถาม
- ให้ router เลือก workflow ก่อนสร้าง prompt สำหรับงานนั้น
- capability manifest ต้องมาจาก tools ที่ค้นพบจริง
- ห้ามอ้างว่าค้นเว็บหรือแก้ไฟล์ หากไม่มี successful observation

เกณฑ์ผ่าน:

- คำถามทั่วไปตอบเป็นธรรมชาติ
- คำถามปัจจุบัน/เฉพาะทางเรียก search
- คำถามไฟล์อ่านไฟล์ก่อนตอบ
- งาน MCP จึงจะได้รับ MCP creation instructions

### 6. เก็บและแสดง Agent trace

- เก็บ action, arguments, observation และ error ของแต่ละ turn
- เพิ่มโหมดแสดง trace เช่น `/debug on`
- เก็บ trace แยกจาก chat history เพื่อไม่ทำให้ context ปน
- redact secrets ก่อนบันทึก

เกณฑ์ผ่าน:

- ย้อนดูได้ว่า `.gitignore` ถูกสร้างจาก action อะไร อ่านไฟล์ใด และตรวจอะไรบ้าง

### 7. เพิ่ม deterministic validators

- งานเขียนไฟล์ต้องอ่านไฟล์/โครงสร้างที่เกี่ยวข้องก่อน
- หลังเขียนให้เลือก validator ตามชนิดงาน:
  - TypeScript: `tsc --noEmit`
  - MCP: discovery และ tool call
  - `.gitignore`: `git check-ignore`, `git status`, `git ls-files`
  - JSON: parse/validate schema
- ห้ามตอบว่าสำเร็จหาก validator ล้มเหลว

เกณฑ์ผ่าน:

- Agent ตรวจพบ `.gitignore` ที่ ignore ตัวเองและปฏิเสธงานก่อน final

### 8. ปรับ Web Search pipeline

- เพิ่ม query rewrite โดยเฉพาะคำถามภาษาไทย/คำสแลง
- ตรวจ relevance ของ title/snippet กับคำถาม
- ถ้าผลไม่เกี่ยวข้อง ให้ค้นซ้ำด้วย query อื่น
- เพิ่ม tool เปิดอ่านหน้าเว็บจริงแบบจำกัด URL และป้องกัน SSRF
- ใช้อย่างน้อย 2 แหล่งที่เกี่ยวข้องก่อนสรุปข้อเท็จจริงที่ไม่แน่นอน
- ให้ host แนบ URL แต่ห้ามถือว่าการมี URL แปลว่าเนื้อหาถูกต้อง

เกณฑ์ผ่าน:

- คำถาม Meme 67 ต้องได้แหล่งที่พูดถึง “6-7”, ต้นกำเนิด หรือบริบท TikTok จริง
- ถ้าหาหลักฐานที่เกี่ยวข้องไม่ได้ ต้องตอบว่าไม่พอ ไม่แต่งคำอธิบาย

### 9. ทำ regression suite

- เพิ่ม test cases จากเหตุการณ์จริงทั้งหมด
- ตรวจทั้ง direct model, router decision, tool action, validator และ final answer
- ใช้ assertions อย่างน้อย:
  - ไม่มีแหล่งที่ไม่เกี่ยวข้อง
  - ไม่อ้าง tool ที่ไม่มี
  - ไม่ตอบเรื่อง server เมื่อถาม session storage
  - ไม่รายงานว่าแก้ไฟล์สำเร็จก่อน validation
- แยก offline tests ออกจาก tests ที่ต้องใช้ llama-server/network

## ลำดับการตัดสินใจเรื่องโมเดล

1. ตรวจว่า GGUF เป็น Instruct และ chat template ถูกต้อง
2. ทดสอบ direct API ด้วย sampling คงที่
3. ถ้ายังตอบความรู้พื้นฐานผิด ให้เปลี่ยนโมเดลก่อน
4. ถ้า direct API ถูกแต่ Agent ผิด ให้แก้ prompt/context/router
5. ทดสอบ regression suite อีกครั้งหลังเปลี่ยนทุกส่วน

## คำสั่งเริ่มงานพรุ่งนี้

```powershell
cd "D:\Work Space\AI Project\cli"
git status --short --ignored
npm run test:mcp
npx tsc --noEmit
npm run dev
```

เริ่มจากหัวข้อ 1 และทำทีละหัวข้อ ห้ามแก้หลาย subsystem พร้อมกัน เพราะจะระบุ
ไม่ได้ว่าคุณภาพดีขึ้นจากการเปลี่ยนส่วนใด
