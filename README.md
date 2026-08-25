# Local Coding Agent CLI — llama.cpp / OpenRouter

CLI coding agent ที่รันโมเดล GGUF บนเครื่องผ่าน `llama.cpp` หรือสลับไปใช้ OpenRouter ได้ รองรับการอ่านและแก้ไฟล์, ตรวจ diff, รันคำสั่งและ test, checkpoint, session, MCP และ file attachment

> [!NOTE]
> ผลที่ทดลองบนเครื่องเจ้าของโปรเจกต์: **Qwen3.8-27B-UD-IQ2_M** ซึ่งเป็น quant ระดับ **IQ2_M (แทบต่ำที่สุดในชุดที่ใช้)** รันบน **RTX 4070 SUPER VRAM 12 GB** ได้ประมาณ **35 tokens/s** และสามารถรับ prompt เดียวเพื่อสร้าง UI แนว coding agent พร้อมเชื่อม API ที่ใช้งานได้จริง ตัวเลขนี้เป็นผลจากเครื่องและ workload นี้ ไม่ใช่การรับประกันความเร็วของทุกเครื่อง

## จุดเด่นของชุดทดลองนี้

- ใช้โมเดล 27B quant ต่ำบนการ์ดจอ VRAM เพียง 12 GB
- เริ่มทั้ง `llama-server` และ CLI ได้จากคำสั่งเดียว
- ตรวจ GPU แล้วเลือก CUDA, SYCL, Vulkan, Metal หรือ CPU ให้อัตโนมัติ
- ดาวน์โหลด binary ของ llama.cpp จาก official release และตรวจ SHA-256 ให้เมื่อยังไม่มี runtime
- จัดการ JSON/tool response จากโมเดลด้วย schema validation, bounded repair/regeneration และปฏิเสธคำตอบที่ขาดหรือมีหลาย action แบบกำกวม
- มี workflow สำหรับแก้โค้ดจริง: inspect, patch, diff, build/test, checkpoint และ rollback
- รองรับ OpenRouter, MCP, session แยก workspace และไฟล์ Word/Excel/text

## ผลการทดลองที่อยากเน้น

| รายการ | ค่าที่ทดลอง |
| --- | --- |
| โมเดล | `Qwen3.8-27B-UD-IQ2_M` |
| ขนาดโมเดลต้นฉบับ | 27B |
| Quant | `IQ2_M` — ระดับต่ำมาก เน้นประหยัดหน่วยความจำ |
| GPU | NVIDIA RTX 4070 SUPER |
| VRAM | 12 GB |
| Context ที่ตั้ง | 16,384 tokens |
| KV cache | `q4_0` |
| ความเร็วที่สังเกต | ประมาณ 35 tokens/s |
| งานที่ผ่านในการทดลอง | prompt เดียวสร้าง UI แนว Codex/coding agent และเชื่อม API ใช้งานได้จริง |

ความเร็วขึ้นกับ prompt, context ที่สะสม, backend/build ของ llama.cpp, sampling, offload และโปรแกรมอื่นที่ใช้ VRAM อยู่ ควรรายงานค่าจากหน้าจอ benchmark/log ของเครื่องตัวเองเมื่อแชร์ผล

## สิ่งที่ต้องมี

- Windows 10/11, Linux หรือ macOS
- Git
- Node.js 20 ขึ้นไป (แนะนำ Node.js 22 LTS)
- npm
- โมเดลไฟล์ `.gguf`
- GPU ไม่บังคับ แต่แนะนำสำหรับความเร็วที่ใช้งานจริง

## เริ่มแบบเร็วที่สุด

ตัวอย่างด้านล่างใช้ PowerShell บน Windows

```powershell
git clone https://github.com/panittasask/cli_project.git
cd cli_project
npm install

New-Item -ItemType Directory -Force D:\Models
Copy-Item .cli\settings.example.json .cli\settings.json
notepad .cli\settings.json
```

นำไฟล์ GGUF ไปวางใน `D:\Models` แล้วแก้ `.cli/settings.json` ให้ชื่อไฟล์ตรงกับของจริง ตัวอย่างสำหรับเครื่อง RTX 4070 SUPER 12 GB:

```json
{
  "modelPath": "D:\\Models",
  "provider": "llama.cpp",
  "serverHost": "127.0.0.1",
  "serverPort": 8080,
  "apiUrl": "http://127.0.0.1:8080/v1/chat/completions",
  "routerMode": false,
  "modelsMax": 1,
  "defaultModel": "Qwen3.8-27B-UD-IQ2_M.gguf",
  "contextLength": 16384,
  "device": "auto",
  "hardwareProfile": "rtx-4070-super",
  "llamaRuntime": {
    "fit": "off",
    "gpuLayers": "all",
    "batchSize": 128,
    "ubatchSize": 64,
    "kvCacheType": "q4_0",
    "reasoningBudget": 2048
  },
  "agent": {
    "profile": "standard",
    "maxTurns": 12,
    "maxSegments": 1,
    "maxDurationMinutes": 8,
    "maxCompletionTokens": 8000
  }
}
```

> [!IMPORTANT]
> `defaultModel` ต้องตรงกับชื่อไฟล์ GGUF ทุกตัวอักษร และ `.cli/settings.json` เป็นไฟล์เฉพาะเครื่องซึ่ง Git จะไม่ติดตาม

จากนั้นเริ่มระบบ:

```powershell
npm start
```

`npm start` จะทำตามลำดับนี้:

1. อ่าน settings และหาไฟล์ GGUF
2. ใช้ `LLAMA_CPP_DIR` หรือ `llamaCppPath` หากมี llama.cpp ที่ใช้ได้อยู่แล้ว
3. ถ้ายังไม่มี จะตรวจ hardware, ดาวน์โหลด official llama.cpp release ที่ตรงกับ backend และตรวจ SHA-256
4. เก็บ runtime ที่ดาวน์โหลดไว้ใต้ `.cli/runtime/`
5. เปิด `llama-server`, รอ health check แล้วเปิด CLI
6. เมื่อออกจาก CLI จะปิดเฉพาะ server ที่ launcher ตัวนี้เป็นผู้เปิด

ถ้ามี server รันอยู่ก่อนแล้ว launcher จะนำกลับมาใช้และไม่ปิด process นั้น

## อธิบาย settings ที่สำคัญ

| Field | ใช้ทำอะไร |
| --- | --- |
| `llamaCppPath` | โฟลเดอร์ llama.cpp ที่ดาวน์โหลด/แตกไฟล์เอง เว้นไว้ได้หากใช้ auto-download |
| `modelPath` | โฟลเดอร์รวมไฟล์ GGUF |
| `defaultModel` | ชื่อไฟล์โมเดลเริ่มต้น |
| `contextLength` | ขนาด context; ยิ่งสูงยิ่งใช้ VRAM/RAM มาก |
| `device` | `auto` หรือชื่อ device จาก `llama-server --list-devices` |
| `hardwareProfile` | `auto`, `rtx-4070-super`, `intel-arc` หรือ `default` |
| `llamaRuntime.fit` | การให้ llama.cpp ปรับตามหน่วยความจำ; preset ทดลองนี้ใช้ `off` |
| `llamaRuntime.gpuLayers` | `all` เพื่อพยายาม offload ทุก layer ไป GPU |
| `llamaRuntime.kvCacheType` | ชนิด KV cache; `q4_0` ช่วยลดหน่วยความจำแต่มี trade-off ด้านคุณภาพ |
| `agent.maxTurns` | จำนวนรอบสูงสุดที่ agent ทำงานต่อหนึ่งคำขอ |
| `projectChecks` | คำสั่ง build/test ที่ให้ agent ใช้ตรวจงานของ project |

ไฟล์ตัวอย่างฉบับเต็มอยู่ที่ [`.cli/settings.example.json`](./.cli/settings.example.json)

## ดาวน์โหลด llama.cpp เอง

วิธี auto-download ด้านบนง่ายที่สุด แต่ถ้าต้องการ pin build หรือจัดการ runtime เอง:

1. เปิดหน้า [official llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases)
2. เลือก binary ให้ตรงระบบและ GPU

   | เครื่อง | Asset ที่ควรมองหา |
   | --- | --- |
   | NVIDIA Windows | `win-cuda-12.x-x64.zip` และแพ็ก `cudart` รุ่นเดียวกันถ้า release นั้นแยกไฟล์ |
   | AMD/ทั่วไป Windows | `win-vulkan-x64.zip` |
   | Intel Arc Windows | `win-sycl-x64.zip` |
   | CPU Windows | `win-cpu-x64.zip` |
   | macOS Apple silicon | Metal build ตามคำแนะนำของ official project |

3. แตกไฟล์ทั้งหมดลงโฟลเดอร์เดียวกัน เช่น `D:\llama.cpp\b12345`
4. ตรวจ runtime:

   ```powershell
   D:\llama.cpp\b12345\llama-server.exe --version
   D:\llama.cpp\b12345\llama-server.exe --list-devices
   ```

5. ใส่ path ใน settings:

   ```json
   {
     "llamaCppPath": "D:\\llama.cpp\\b12345"
   }
   ```

หากต้อง build เอง ให้ทำตาม [official build guide](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md) และสำหรับ Intel GPU ดู [SYCL backend guide](https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/SYCL.md)

## เปิด server และ CLI แยกสอง Terminal

วิธีนี้เหมาะเวลาต้องการดู log ของ server ตลอด และใช้ runtime tuning จาก `llamaRuntime` เต็มรูปแบบ

Terminal 1:

```powershell
npm run llama
```

Terminal 2:

```powershell
npm run dev:cli
```

ถ้า `npm run dev:cli` แจ้ง module/package หายหลัง merge หรือ pull ให้รัน:

```powershell
npm install
```

เพราะ `package.json` และ `package-lock.json` อาจมี dependency ใหม่ที่ยังไม่อยู่ใน `node_modules` ของเครื่อง

## คำสั่งใน CLI ที่ใช้บ่อย

| คำสั่ง | การทำงาน |
| --- | --- |
| `/help` | ดูคำสั่งทั้งหมด |
| `/workspace <path>` | เปลี่ยน workspace ของ session |
| `/settings init` | สร้าง settings local จาก template โดยไม่ทับไฟล์เดิม |
| `/attach "<path>" \| <คำขอ>` | แนบไฟล์พร้อมคำสั่ง |
| `/readfile "<path>" \| <คำขอ>` | อ่านไฟล์แล้วส่งให้โมเดลวิเคราะห์ |
| `/clear` | เริ่ม context ใหม่ใน session ปัจจุบัน |

สามารถลากไฟล์จาก Explorer มาวางที่ prompt ได้ รองรับ text, Markdown, JSON, CSV, Word (`.doc`, `.docx`) และ Excel (`.xls`, `.xlsx`, `.xlsm`, `.xlsb`) โดยแปลงเป็นข้อความแบบจำกัดขนาดก่อนส่งเข้าโมเดล

## ใช้ OpenRouter แทน local model

คัดลอก template แล้วใส่ key เฉพาะในไฟล์ local:

```powershell
Copy-Item .cli\api-endpoints.template.json .cli\api-endpoints.json
notepad .cli\api-endpoints.json
```

ตัวอย่าง:

```json
{
  "provider": "openrouter",
  "apiUrl": "https://openrouter.ai/api/v1/chat/completions",
  "bearerToken": "ใส่-key-ที่นี่",
  "httpReferer": "https://your-site.example",
  "xTitle": "CLI Project",
  "model": "provider/model-name",
  "requestDelayMs": 1000,
  "reasoning": {
    "effort": "low"
  }
}
```

ห้าม commit `.cli/api-endpoints.json`, `.env` หรือ API key ขึ้น Git

## ใช้ llama.cpp Server จากอีกเครื่อง

ตั้ง endpoint ใน PowerShell ปัจจุบัน:

```powershell
$env:LLAMA_API_URL = "http://<server-ip>:8080/v1/chat/completions"
npm run dev:cli
```

เมื่อกำหนด endpoint ภายนอก launcher จะตรวจ endpoint นั้นและไม่ดาวน์โหลดหรือเปิด local llama.cpp แทนแบบเงียบ ๆ คู่มือ Windows autostart และ Tailscale แบบละเอียดอยู่ที่ [วิธีการใช้งาน.md](./วิธีการใช้งาน.md)

## ตรวจระบบและรัน test

```powershell
npm test
npx tsc --noEmit
npm run test:e2e
```

คำสั่งเพิ่มเติม:

```powershell
npm run server:status
npm run benchmark:hardware
npm run logs:view
```

Log แยกอยู่ใต้ `.cli/logs/agent`, `server`, `evaluation`, `baseline` และ `benchmark`

## แก้ปัญหาที่พบบ่อย

### `npm run dev:cli` พังหลัง pull/merge

รัน `npm install` ก่อนเสมอ แล้วลอง `npx tsc --noEmit` เพื่อแยกปัญหา dependency ออกจาก runtime

### หาโมเดลไม่เจอ

- ตรวจว่า `modelPath` เป็นโฟลเดอร์ที่มี `.gguf`
- ตรวจว่า `defaultModel` ตรงกับชื่อไฟล์จริง
- หรือกำหนด `$env:LLAMA_MODEL` เป็น path เต็มชั่วคราว

### VRAM ไม่พอ

- ปิดโปรแกรมอื่นที่ใช้ GPU
- ลด `contextLength`
- ใช้ KV cache ที่เล็กลง
- ลด batch/ubatch
- เลือก quant ที่เล็กลง
- เปิด `fit` หากต้องการให้ llama.cpp ช่วยปรับตามหน่วยความจำ

### JSON/tool call จาก local model ผิดรูปแบบ

ตัว harness มี schema validation และ retry แบบจำกัดอยู่แล้ว แต่ไม่มี parser ใดทำให้คำตอบที่กำกวมหรือถูกตัดหายกลับมาถูกต้องได้ 100% วิธีที่ได้ผลที่สุดคือใช้ schema ที่ชัด, ลด temperature ใน action mode, ให้ token budget พอ และใช้โมเดลที่ทำ structured output ได้ดี

## ความเป็นส่วนตัวก่อนแชร์ repo

- `.cli/settings.json`, `.cli/api-endpoints.json`, `.env`, `.cli-sessions.json`, runtime และ logs ถูก ignore
- อย่าใส่ API key, IP ภายใน, username, path ส่วนตัว หรือข้อความใน session ลง screenshot
- ตรวจ `git status` และ diff ก่อน commit ทุกครั้ง
- หากไฟล์ลับเคยถูก commit แล้ว การเพิ่ม `.gitignore` อย่างเดียวไม่ลบไฟล์ออกจาก Git history

## โครงสร้างหลัก

```text
cli/                 ตัว CLI, agent loop, protocol และ tools
scripts/             launcher, server management, benchmark และ tests
.cli/                settings template, MCP config และ skills
docs/                เอกสารและโพสต์สำหรับแชร์
วิธีการใช้งาน.md      คู่มือ server/office/Tailscale ภาษาไทย
```

## โพสต์แชร์

มีข้อความโพสต์ฉบับสั้น ฉบับละเอียด และ checklist รูปประกอบพร้อมใช้ที่ [docs/SHARE_POST_TH.md](./docs/SHARE_POST_TH.md)

โปรเจกต์นี้ยังอยู่ในช่วงทดลอง ควรตรวจ diff และผล test ก่อนยอมรับการแก้ไขจากโมเดล โดยเฉพาะเมื่อใช้ quant ต่ำหรือให้ agent รันคำสั่งใน workspace จริง
