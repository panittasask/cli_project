# ข้อความสำหรับแชร์ Local Coding Agent CLI

เลือกใช้ข้อความด้านล่างได้ตามความยาวที่เหมาะกับกลุ่ม ตัวเลข performance เป็นผลที่สังเกตจากเครื่องทดลอง ควรแนบภาพ benchmark/log เพื่อให้ข้อมูลตรวจสอบได้

## เวอร์ชันสั้น

ลองทำ Local Coding Agent CLI ที่รันผ่าน llama.cpp สำเร็จแล้วครับ

จุดที่เซอร์ไพรส์มากคือใช้ **Qwen3.8-27B-UD-IQ2_M** ซึ่งเป็น quant แบบ **IQ2_M แทบจะต่ำที่สุดในชุดที่มี** แต่รันบน **RTX 4070 SUPER VRAM แค่ 12 GB** ได้ประมาณ **35 tokens/s** และยังทำตาม prompt เดียวเพื่อสร้าง UI แนว Codex/coding agent พร้อมเชื่อม API ที่ใช้งานได้จริง

ตัว CLI ทำงานกับไฟล์ใน workspace ได้ มี diff/checkpoint, รัน build และ test, session, MCP, file attachment และมีชั้นรับมือ structured output จาก local model เช่น schema validation, repair/retry แบบจำกัด และปฏิเสธ action ที่กำกวมหรือถูกตัดหาย

เปิด repo แล้วทำตาม README ได้ตั้งแต่ติดตั้ง Node/npm, ตั้ง `.cli/settings.json`, ดาวน์โหลด llama.cpp อัตโนมัติหรือโหลดเอง ไปจนถึงเริ่ม server และ CLI:

https://github.com/panittasask/cli_project

ผล 35 tok/s เป็นค่าจากเครื่องและ workload ที่ผมทดลอง ความเร็วจริงขึ้นกับ context, llama.cpp build, offload และ VRAM ที่เหลือครับ ใครมีการ์ด 12 GB หรือเคยลอง quant ต่ำกับ coding agent มาแลกผลกันได้เลย

## เวอร์ชันละเอียด

มาแชร์โปรเจกต์ทดลอง **Local Coding Agent CLI** ที่ต่อกับ llama.cpp/OpenRouter ครับ

ผมอยากรู้ว่าโมเดล quant ต่ำมากบน GPU ระดับผู้ใช้ทั่วไปจะไปได้ไกลแค่ไหน เลยลองชุดนี้:

- Model: `Qwen3.8-27B-UD-IQ2_M`
- Original size: 27B
- Quant: `IQ2_M` ซึ่งแทบจะต่ำที่สุดในชุดที่ใช้
- GPU: RTX 4070 SUPER
- VRAM: 12 GB
- Context ที่ตั้ง: 16K
- KV cache: q4_0
- ความเร็วที่สังเกต: ประมาณ 35 tokens/s

สิ่งที่เกินคาดคือมันไม่ได้แค่ตอบแชตได้ แต่รับ prompt เดียวแล้วสร้าง UI แนว Codex/coding agent พร้อมเชื่อม API จนใช้งานจริงได้ ตัว model เล็กในแง่ไฟล์/quant และใช้ VRAM แค่ 12 GB แต่คุณภาพการทำงานกับ agent harness รอบนี้นิ่งกว่าที่คาดมาก

ฝั่ง harness มีของที่จำเป็นสำหรับงานโค้ดจริง เช่น:

- inspect และแก้ไฟล์ใน workspace
- preview diff, checkpoint และ rollback
- รัน command, build และ test เพื่อตรวจงาน
- session แยก workspace
- MCP และ file attachment สำหรับ text/Word/Excel
- รองรับทั้ง local llama.cpp และ OpenRouter
- ตรวจ JSON/tool action ด้วย schema
- repair หรือ regenerate แบบมีขอบเขต
- ไม่เดาคำตอบต่อเมื่อ JSON เหมือนถูกตัด และไม่ยอมรับหลาย action ที่กำกวม

การเริ่มใช้งานทำให้สั้นที่สุดด้วย `npm start` ตัว launcher จะตรวจ hardware แล้วเลือก CUDA/SYCL/Vulkan/Metal/CPU ให้ ถ้าไม่มี llama.cpp จะโหลด official release ที่ตรงกับเครื่อง ตรวจ SHA-256 และเปิด server พร้อม CLI อัตโนมัติ ส่วนคนที่ต้องการ pin build ก็โหลด llama.cpp เองและชี้ `llamaCppPath` ได้

README มีขั้นตอนครบตั้งแต่:

1. clone และ `npm install`
2. เตรียม GGUF
3. สร้าง `.cli/settings.json`
4. ดาวน์โหลด/ตั้งค่า llama.cpp
5. เปิดแบบคำสั่งเดียวหรือแยก server กับ CLI
6. ทดสอบระบบและแก้ปัญหาที่พบบ่อย

Repo: https://github.com/panittasask/cli_project

หมายเหตุ: **35 tokens/s เป็นผลจากเครื่องและ workload ของผม ไม่ใช่ตัวเลขรับประกัน** ความเร็วเปลี่ยนตาม prompt, context ที่สะสม, build/backend, sampling, GPU offload และโปรแกรมอื่นที่แย่ง VRAM แต่ผลนี้อย่างน้อยแสดงให้เห็นว่า 27B IQ2_M บน VRAM 12 GB ก็ทำ local coding workflow ที่ใช้งานจริงได้ไกลกว่าที่คิดครับ

ถ้าใครมี GPU 8–16 GB, เคยลอง Qwen quant อื่น หรือมีวิธีปรับ llama.cpp ให้ structured output นิ่งขึ้น มาแชร์ config/ผลทดสอบกันได้ครับ

## เวอร์ชันภาษาพูดสำหรับ Facebook/Discord

เอาจริงอันนี้เซอร์ไพรส์มาก ลองเอา **Qwen3.8-27B-UD-IQ2_M** ซึ่ง quant ต่ำระดับ IQ2_M มารันกับ **4070 SUPER VRAM แค่ 12 GB** แต่ได้ประมาณ **35 tok/s** แล้วสั่ง prompt เดียวให้ทำ UI แนว Codex พร้อมต่อ API มันทำจนใช้ได้จริง

ผมเลยรวม harness ที่ใช้ไว้เป็น repo มีทั้งแก้ไฟล์, ดู diff, checkpoint, รัน build/test, session, MCP, แนบ Word/Excel และตัวกัน JSON/tool call พังสำหรับ local model README เขียนตั้งแต่ settings, หา GGUF, โหลด llama.cpp จนเปิดใช้งานได้เลย

Repo: https://github.com/panittasask/cli_project

35 tok/s เป็นผลบนเครื่องผมและงานที่ลองนะ ไม่ได้รับประกันทุก prompt แต่สำหรับ 27B + IQ2_M + 12 GB VRAM คือเกินคาดมาก ใครลองเครื่องใกล้ ๆ กันอยู่มาเทียบ config กันครับ

## รูปที่ควรแนบ

เรียง 3–5 รูปกำลังดี:

1. หน้าจอ `nvidia-smi` ที่เห็นชื่อ GPU, VRAM และ process แต่ไม่ติดข้อมูลส่วนตัว
2. log ที่เห็นชื่อโมเดล, quant, context และความเร็วประมาณ 35 tok/s
3. prompt ต้นทางแบบสั้น
4. UI ที่โมเดลสร้างสำเร็จ
5. หน้าจอที่ API ตอบจริงหรือผล build/test ผ่าน

ใช้คำบรรยายใต้รูป เช่น:

> Qwen3.8-27B IQ2_M / RTX 4070 SUPER 12 GB / llama.cpp / context 16K — observed ~35 tok/s ใน workload นี้

## Checklist ก่อนกดโพสต์

- เปิดลิงก์ repo แบบ incognito แล้วตรวจว่า README และไฟล์ที่จำเป็นเข้าถึงได้
- clone ลงโฟลเดอร์ใหม่ แล้วลอง `npm install` และ `npm start`
- ตรวจว่าไม่มี `.env`, API key, bearer token หรือ `.cli/api-endpoints.json`
- ตรวจว่าไม่มี `.cli-sessions.json`, prompt ส่วนตัว หรือ logs
- เบลอ username, IP ภายใน, path ส่วนตัว และชื่อโปรเจกต์ลูกค้าใน screenshot
- ระบุ model, quant, GPU, VRAM, context และ backend ให้ครบ
- ใช้คำว่า “ประมาณ/observed” กับตัวเลข 35 tok/s
- บอกว่างานที่ใช้วัดคืออะไร เพื่อไม่ให้คนเข้าใจว่าเป็น benchmark มาตรฐาน
- เพิ่ม LICENSE ให้ชัดเจนก่อนชวนคนอื่นนำโค้ดไปใช้หรือ contribute

## Hashtags ที่เลือกใช้ได้

`#LocalLLM` `#llamacpp` `#Qwen` `#CodingAgent` `#AIEngineering` `#OpenSource` `#RTX4070SUPER`
