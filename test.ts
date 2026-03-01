import helotsExtension from "./helots_copy.ts";
import * as path from "node:path";
import * as process from "node:process";

const mockPiApi = {
    registerTool: (toolDef: any) => {
        console.log("Tool registered:", toolDef.name);
        if (toolDef.name === "helot_slinger") {
            toolDef.execute("123", {
                researchTask: "Explain the purpose of the LlamaClient class in this project.",
                targetFiles: [path.join(process.cwd(), "helots_copy.ts")]
            }, {}, (data: any) => {
                const text = data?.content?.[0]?.text || JSON.stringify(data);
                console.log("SLINGER UPDATE:", text);
            }, {}).then((res: any) => {
                console.log("SLINGER RESULT:", JSON.stringify(res?.content?.[0]?.text || res, null, 2));
            }).catch((err: any) => {
                console.error("SLINGER ERROR:", err);
            });
        }
    },
    unregisterTool: (name: string) => {
        console.log("Unregistered tool:", name);
    }
};

helotsExtension(mockPiApi as any);
