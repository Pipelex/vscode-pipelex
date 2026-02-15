/**
 * MTHDS TextMate grammar generator.
 *
 * This script produces only `mthds.tmLanguage.json` (the core grammar).
 *
 * The sibling files `mthds.frontmatter.tmLanguage.json` and
 * `mthds.markdown.tmLanguage.json` are static injection wrappers — they
 * contain no grammar rules of their own and simply delegate to
 * `source.mthds`. They are hand-edited and do not need generation.
 * This mirrors the upstream TOML pattern (`toml.frontmatter.tmLanguage.json`,
 * `toml.markdown.tmLanguage.json` are also static, hand-edited files).
 *
 * Run: `yarn build:syntax` (or `npx tsx src/syntax/mthds/index.ts`)
 */

import * as path from "path";
import { writeFileSync } from "fs";
import { comment, commentDirective } from "./comment";
import { dataInjection, templateVariable } from "./injection";
import { value, stringEscapes } from "./value";
import { jinjaTemplateContent, jinjaStatements, jinjaExpressions } from "./jinja";
import { htmlContent, htmlAttributes } from "./html";
import { table } from "./table";
import { entryBegin } from "./entry";

const syntax = {
  version: "1.0.0",
  scopeName: "source.mthds",
  uuid: "8b4e5008-c50d-11ea-a91b-54ee75aeeb97",
  information_for_contributors: [
    "Originally was maintained by aster (galaster@foxmail.com). This notice is only kept here for the record, please don't send e-mails about bugs and other issues.",
  ],
  patterns: [
    {
      include: "#commentDirective",
    },
    {
      include: "#comment",
    },
    {
      include: "#table",
    },
    {
      include: "#entryBegin",
    },
    {
      include: "#value",
    },
  ],
  repository: {
    comment,
    commentDirective,
    table,
    entryBegin,
    value,
    jinjaTemplateContent,
    jinjaStatements,
    jinjaExpressions,
    htmlContent,
    htmlAttributes,
    dataInjection,
    templateVariable,
    stringEscapes,
  },
};

writeFileSync(
  path.resolve(__dirname, path.join("..", "..", "..", "mthds.tmLanguage.json")),
  JSON.stringify(syntax, null, 2)
);
