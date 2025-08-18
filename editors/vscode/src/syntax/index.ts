import * as path from "path";
import { writeFileSync } from "fs";
import { comment, commentDirective } from "./comment";
import { table, entryBegin } from "./composite";
import { value } from "./composite/value";
import { dataInjection, templateVariable } from "./pipelex/variables";
import { jinjaDelimiters, jinjaKeywords, jinjaVariable, htmlTag, htmlComment } from "./pipelex/templates";

const syntax = {
  version: "1.0.0",
  scopeName: "source.pml",
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
      include: "#dataInjection",
    },
    {
      include: "#templateVariable",
    },
    {
      include: "#jinjaDelimiters",
    },
    {
      include: "#jinjaKeywords",
    },
    {
      include: "#jinjaVariable",
    },
    {
      include: "#htmlTag",
    },
    {
      include: "#htmlComment",
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
    dataInjection,
    templateVariable,
    jinjaDelimiters,
    jinjaKeywords,
    jinjaVariable,
    htmlTag,
    htmlComment,
  },
};

writeFileSync(
  path.resolve(__dirname, path.join("..", "..", "pml.tmLanguage.json")),
  JSON.stringify(syntax, null, 2)
);
