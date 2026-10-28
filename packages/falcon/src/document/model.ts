/**
 * The model seam an extractor uses: `@wrenautomation/models`' `Model`, of which an extractor
 * calls only `ask` and reads only `id`. A model whose output cap cut the answer throws models'
 * `Cut` with the text so far: the claim extractor keeps what is whole and asks again for the rest.
 */
import type { Model as FullModel } from "@wrenautomation/models";

export type { Answer, Usage } from "@wrenautomation/models";
export { addUsage, Cut, isCut } from "@wrenautomation/models";

/** What an extractor needs of a model: any `@wrenautomation/models` model meets it. */
export type Model = Pick<FullModel, "id" | "ask">;
