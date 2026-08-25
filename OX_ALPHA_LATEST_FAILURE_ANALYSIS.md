# Ox Alpha ล่าสุด: Failure Analysis

วันที่ตรวจสอบ: 25 สิงหาคม 2026 (Asia/Bangkok)
Log ที่ใช้ตรวจสอบ:

- `.cli/logs/agent/agent-trace-2026-08-25.jsonl`
- `.cli/logs/agent/agent-model-responses-2026-08-25.jsonl`

## สรุปสั้น

อาการล่าสุดไม่ได้มีสาเหตุเดียว แต่เป็น 4 ชั้นต่อกัน:

1. OpenRouter/Ox Alpha ใช้เวลาตอบนานมากในบาง request โดยเฉพาะ JSON repair ทำให้หน้าจอค้างที่ planning นาน
2. โมเดลส่ง JSON ที่ syntax เสียและบางครั้งส่ง object ที่มีโครงสร้างไม่ครบ
3. local parser เติม field ที่หายให้เป็น string ว่าง ทำให้ payload ที่ไม่ครบผ่าน schema เบื้องต้นได้ แล้วค่อยไป fail ตอน execute
4. หลัง action fail ระบบยังเปิดโอกาสให้โมเดล retry action เดิมต่อ จนเกิด `repeat_quarantine` และ `repeat_stop`

นอกจากนี้ task ล่าสุดยังมี runtime error ในโปรเจกต์ปลายทางเอง ซึ่งไม่ใช่ `ERR_BAD_REQUEST` และไม่ใช่ JSON parser ของ CLI:

```text
panic: Failed to find CreateSolidBrush procedure in user32.dll
D:/Work Space/AI Project/OpenRouterTest/main.go:158
```

`CreateSolidBrush` ถูกเรียกจาก `user32.dll` ทั้งที่ฟังก์ชันนี้อยู่ใน `gdi32.dll` จึง compile ผ่านได้ แต่พังเมื่อรันจริง

## Timeline ล่าสุด

Task ID: `task_mt8bid99_ur1ey`

| เวลาโดยประมาณ | เหตุการณ์ | ผล |
|---|---|---|
| 14:02:40 | เริ่ม task | เริ่มงานได้ แต่ guard แสดง `maxDurationMs: 0` |
| 14:02:44 | ได้ task contract และ `list_files` | ผ่าน |
| 14:02:47 | อ่าน `main.go` | ผ่าน |
| 14:02:56 | `go build ./...` | ผ่าน |
| 14:03:00 | `go test ./...` | ผ่าน แต่ไม่มี test (`[no test files]`) |
| 14:03:07 | build เป็น `.exe` | ผ่าน |
| 14:03:17 | สรุป final ถูก block | runtime verification ยังไม่ผ่าน |
| 14:03:24 | รัน `.exe` แบบ probe | panic จาก `CreateSolidBrush` |
| 14:03:31 | `edit_file` ย้าย DLL binding | ถูก rollback เพราะ validator แจ้ง `Written file is missing: main.go` |
| 14:03:44 | อ่านไฟล์ใหม่ | พบว่า `gdi32` ถูกเพิ่มแล้ว แสดงว่า state ระหว่าง validator/checkpoint กับ workspace ไม่ตรงกัน |
| 14:03:49 | `edit_file` รอบถัดไป | JSON malformed เพราะ quote ใน `NewProc("CreateSolidBrush")` ไม่ถูก escape |
| 14:03:54 | JSON repair | ได้ object ที่ syntax ใช้ได้ แต่ field `old_text` เสีย/หาย ทำให้ semantic ไม่ถูกต้อง |
| 14:04:05 | `edit_file` | execute ต่อ แต่ยังเกิดปัญหา validation/ไฟล์ |
| 14:04:50 | response ยาว 45.6 วินาที | ได้ object ที่มี `action` แต่จบด้วย content ขนาดใหญ่และเริ่มผิดรูปแบบ |
| 14:07:18 | JSON repair | ใช้เวลา 147.6 วินาที, `finish_reason=length`, content ว่าง |
| 14:07:52–14:09:30 | `write_file` ซ้ำ | payload ไม่มี `path` ที่ใช้งานได้ จึงเกิด `Missing file path` ซ้ำ และถูกหยุดด้วย repeat guard |

## สาเหตุที่ยืนยันได้

### 1. Runtime error อยู่ในโปรเจกต์ปลายทาง

ใน `OpenRouterTest/main.go` มีการประกาศประมาณนี้:

```go
pCreateSolidBrush = user32.NewProc("CreateSolidBrush")
```

เมื่อรันจริง Windows หา procedure นี้ใน `user32.dll` ไม่เจอ จึง panic ตอนเรียก `.Call()` แม้ `go build` และ `go test` จะผ่าน

ดังนั้น build ผ่านในกรณีนี้ไม่ได้แปลว่า runtime ผ่าน และ CLI block final ถูกต้องตามหลักฐานที่มี

### 2. Parser เปลี่ยน field ที่หายให้เป็น string ว่าง

ใน `cli/agent/agentActionParser.ts` มีการสร้าง action แบบนี้:

```ts
path: typeof data.path === "string" ? data.path : ""
old_text: typeof data.old_text === "string" ? data.old_text : ""
```

ผลคือ object ที่ไม่มี `path` หรือ `old_text` ไม่ถูกปฏิเสธทันที แต่ถูกแปลงเป็น:

```json
{
  "action": "write_file",
  "path": ""
}
```

จากนั้น schema ปัจจุบันตรวจเพียงว่าเป็น `string` ไม่ได้ตรวจว่า field ต้องมีและห้ามว่าง จึง action ผ่าน parser ได้ แล้วค่อยไป fail ที่ executor ด้วย `Missing file path.`

จุดที่เกี่ยวข้อง:

- `cli/agent/agentActionParser.ts:117-144`
- `cli/agent/schema/actions/writeFile.schema.ts:4-10`
- `cli/agent/schema/actions/editFile.schema.ts:4-12`
- `cli/tools/agentActionExecutor.ts:80-92`
- `cli/tools/workspaceFileTools.ts:29-30`

นี่เป็นสาเหตุหลักที่เห็น `write_file` ถูกนับว่า accepted ทั้งที่ execute ไม่ได้

### 3. JSON repair แก้ syntax ได้ แต่ไม่ได้ทำให้ semantic ถูกต้อง

ตัวอย่างจาก log รอบ `edit_file`:

```json
{
  "action": "edit_file",
  "new_text": "...",
  "CreateSolidBrush\")\"": "old_text",
  "path": "main.go"
}
```

JSON ตัวนี้ parse ได้ แต่ไม่ได้มี `old_text` ที่ถูกต้อง การใช้ `jsonrepair` จึงช่วยเรื่อง quote/comma/newline เท่านั้น ไม่สามารถกู้ความหมายของ source code ที่โมเดลส่งผิดได้

### 4. จำกัด JSON repair ไว้ 1 ครั้ง แต่ไม่ได้หยุด action recovery ทั้งหมด

ค่า `MAX_JSON_REPAIR_ATTEMPTS` เป็น 1 จริง แต่หลัง repair ไม่สำเร็จ ระบบยังกลับไป normal recovery และถามโมเดลต่อใน turn ใหม่ได้

จึงเกิดลำดับนี้:

```text
malformed response
 -> local repair
 -> LLM repair 1 ครั้ง
 -> repair ได้ payload ไม่ครบ/finish length
 -> normal recovery ต่อ
 -> โมเดลส่ง write_file เดิมซ้ำ
 -> Missing file path ซ้ำ
 -> repeat_quarantine
 -> repeat_stop
```

จุดที่เกี่ยวข้องคือ `cli/agent/agentRunner.ts:423-535` และ repeat guard ใน runner/action flow

### 5. Repair request ใช้เวลานานและถูกตัดด้วย token limit

จาก response log:

```text
turn 12 normal response: 45,608 ms
turn 12 json_repair: 147,588 ms
finish_reason: length
rawContent: ""
```

ดังนั้นอาการ planning นานไม่ได้เกิดจาก parser อย่างเดียว แต่เกิดจาก model ใช้เวลา/โควต้าไปกับ response และ repair จนไม่มี action JSON กลับมา

## สิ่งที่ยังสรุปไม่ได้จาก log ปัจจุบัน

response log ล่าสุดทุก entry มี `toolCall` ว่าง จึงยังไม่มีหลักฐานว่า task นี้ได้รับ tool call จาก OpenRouter จริง หรือถูก fallback กลับมาเป็น plain structured JSON

ตอนนี้ log เก็บ raw provider content แล้ว แต่ยังไม่ได้เก็บข้อมูล transport สำคัญต่อไปนี้แบบชัดเจน:

- request แรกถูกส่งด้วย `tools` หรือไม่
- OpenRouter ตอบ HTTP 400 หรือไม่ก่อน fallback
- fallback payload ถูกใช้หรือไม่
- response healing ถูกใช้กับ request ใด

ดังนั้นยังไม่ควรสรุปว่า OpenRouter down หรือ tool calling ใช้งานไม่ได้จาก log นี้เพียงอย่างเดียว

## สรุป root cause แยกตามชั้น

| ชั้น | อาการ | สาเหตุ |
|---|---|---|
| Provider/model | ตอบช้า, JSON เสีย, repair จบด้วย `length` | Ox Alpha ใช้ token/reasoning สูงและสร้าง source code ใน JSON ไม่เสถียร |
| Transport | ไม่เห็น tool call ใน log | ยังไม่มี transport telemetry ที่บอก tools/fallback/HTTP response ชัดเจน |
| Parser | action ที่ไม่มี path ยังถูก accepted | parser เติมค่าหายเป็น `""` และ schema อนุญาต empty string |
| Repair | syntax ดีขึ้นแต่ field เพี้ยน | JSON repair ไม่สามารถกู้ semantic ของ source code ได้ |
| Runner | `write_file` เดิมวนซ้ำหลายรอบ | repair จำกัด 1 ครั้ง แต่ normal recovery ยังเดินต่อหลัง invalid action |
| Validator/checkpoint | แก้แล้วแจ้ง `Written file is missing` | state/path ที่ validator ตรวจไม่ตรงกับ workspace ณ ตอนนั้น ต้องแยกตรวจเพิ่ม |
| Target application | `.exe` panic | `CreateSolidBrush` ผูกกับ DLL ผิด (`user32.dll` แทน `gdi32.dll`) |

## ข้อเสนอแนะให้แก้ตามลำดับ

### P0 — ห้ามให้ action ที่ field ไม่ครบผ่าน parser

- ห้ามเติม `path`, `old_text`, `command` ที่หายเป็น string ว่างเพื่อให้ schema ผ่าน
- ให้ missing field ยังคงเป็น `undefined` แล้วปล่อยให้ schema reject
- กำหนด `path` เป็น non-empty string
- กำหนด `edit_file.old_text` เป็น non-empty string
- ตรวจ tool arguments ด้วย schema เดียวกันก่อน execute

### P0 — ถ้า repair ครั้งเดียวไม่ผ่าน ให้จบ turn

หลัง JSON repair ล้มเหลวหรือ `finish_reason=length` ควรคืน parse failure ที่ชัดเจนทันที ไม่ควรเปิด normal action recovery ต่อกับ payload เดิม เพราะจะทำให้เกิดการส่ง `write_file` ซ้ำ

### P1 — แยก runtime failure ออกจาก model repair

เมื่อ runtime probe พบ panic ให้ส่ง error เดิมกลับในรูป observation สั้น ๆ และบังคับให้ model ใช้ `edit_file` ที่มี `path`, `old_text`, `new_text` ครบ ห้ามเปลี่ยนเป็น `write_file` เต็มไฟล์ถ้า response ถูกตัดด้วย length

### P1 — เพิ่ม transport telemetry

ใน debug/response log ควรมีอย่างน้อย:

```text
provider
usedTools
toolChoice
usedResponseHealing
initialHttpStatus
usedFallback
```

โดยห้ามบันทึก bearer token หรือ header secret

### P1 — ลดงบ repair

JSON repair ควรใช้ prompt สั้น, reasoning ต่ำ/ปิด และ max tokens ต่ำกว่ารอบปกติ เพื่อไม่ให้ repair ใช้เวลา 147 วินาทีแล้วจบด้วย `length`

## สรุปสำหรับส่งต่อ

ประโยคสั้น ๆ คือ:

> ปัญหาหลักไม่ได้อยู่ที่ OpenRouter 400 อย่างเดียว แต่เป็น chain ของ Ox Alpha ที่ส่ง JSON/source code เพี้ยน → parser เติม field ที่หายเป็นค่าว่าง → action ที่ไม่ครบถูก execute → executor ปฏิเสธ → normal recovery ส่ง action เดิมซ้ำ ขณะเดียวกัน JSON repair ใช้เวลานานและถูกตัดด้วย token limit ส่วน runtime panic `CreateSolidBrush` เป็น bug ในโปรเจกต์ปลายทางที่ใช้ DLL ผิด ไม่ใช่ CLI transport โดยตรง
