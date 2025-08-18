import { tableInline } from "./table";
import { array } from ".";
import { string, datetime, boolean, number } from "../literal";
import { conceptName, nativeConcepts, pipeType } from "../pipelex/concepts";
import { dataVariable, dataInjection, templateVariable } from "../pipelex/variables";
import { jinjaDelimiters, jinjaKeywords, jinjaVariable, htmlTag, htmlComment } from "../pipelex/templates";

export const value = {
  patterns: (<Array<any>>[]).concat(
    dataInjection,
    templateVariable,
    jinjaDelimiters,
    jinjaKeywords,
    jinjaVariable,
    htmlTag,
    htmlComment,
    // Removed overly broad patterns: pipeType, nativeConcepts, conceptName, dataVariable
    // These are now handled by semantic token provider for precise context-aware highlighting
    string,
    datetime,
    boolean,
    number,
    array,
    tableInline
  ),
};
