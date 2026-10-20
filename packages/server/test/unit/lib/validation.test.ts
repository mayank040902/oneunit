import { describe, expect, it } from "vitest";
import {
    DEFAULT_MAX_VALIDATION_FIELDS,
    toValidationFields,
} from "../../../src/lib/validation.js";

describe("toValidationFields", () => {
    it("maps issues to a field-keyed error map", () => {
        const fields = toValidationFields([
            { path: ["email"], message: "Invalid email address" },
            { path: ["name"], message: "Too short" },
        ]);

        expect(fields).toEqual({
            email: ["Invalid email address"],
            name: ["Too short"],
        });
    });

    it("joins nested paths with a dot", () => {
        const fields = toValidationFields([
            { path: ["user", "email"], message: "Invalid email address" },
            { path: ["user", "profile", "city"], message: "Required" },
        ]);

        expect(fields).toEqual({
            "user.email": ["Invalid email address"],
            "user.profile.city": ["Required"],
        });
    });

    it("keeps every message for the same field", () => {
        const fields = toValidationFields([
            { path: ["email"], message: "Invalid email address" },
            { path: ["email"], message: "Already taken" },
        ]);

        expect(fields).toEqual({
            email: ["Invalid email address", "Already taken"],
        });
    });

    it("accepts an error object that carries issues", () => {
        const fields = toValidationFields({
            issues: [{ path: ["email"], message: "Invalid email address" }],
        });

        expect(fields).toEqual({ email: ["Invalid email address"] });
    });

    it("returns an empty map for no issues", () => {
        expect(toValidationFields([])).toEqual({});
        expect(toValidationFields(undefined)).toEqual({});
        expect(toValidationFields({})).toEqual({});
    });

    it("uses the fallback key for an issue without a path", () => {
        expect(toValidationFields([{ message: "Invalid body" }])).toEqual({
            _: ["Invalid body"],
        });
    });

    it("uses the fallback message for an issue without one", () => {
        expect(toValidationFields([{ path: ["email"] }])).toEqual({
            email: ["Invalid value"],
        });
    });

    it("honours custom fallbacks", () => {
        const fields = toValidationFields(
            [{ message: "Invalid body" }, { path: ["email"] }],
            { fallbackKey: "_root", fallbackMessage: "Bad value" },
        );

        expect(fields).toEqual({
            _root: ["Invalid body"],
            email: ["Bad value"],
        });
    });

    it("caps the number of fields", () => {
        const issues = Array.from({ length: 10 }, (_, index) => ({
            path: [`field${index}`],
            message: "Invalid",
        }));

        const fields = toValidationFields(issues, { maxFields: 3 });

        expect(Object.keys(fields)).toHaveLength(3);
        expect(fields).toEqual({
            field0: ["Invalid"],
            field1: ["Invalid"],
            field2: ["Invalid"],
        });
    });

    it("keeps later messages for a field that was already counted", () => {
        const issues = [
            { path: ["a"], message: "First" },
            { path: ["b"], message: "Second" },
            { path: ["a"], message: "Third" },
        ];

        const fields = toValidationFields(issues, { maxFields: 1 });

        expect(fields).toEqual({ a: ["First", "Third"] });
    });

    it("caps at the default field count", () => {
        const issues = Array.from({ length: DEFAULT_MAX_VALIDATION_FIELDS + 10 }, (_, index) => ({
            path: [`field${index}`],
            message: "Invalid",
        }));

        expect(Object.keys(toValidationFields(issues))).toHaveLength(DEFAULT_MAX_VALIDATION_FIELDS);
    });

    it("stringifies numeric path segments", () => {
        const fields = toValidationFields([
            { path: ["items", 0, "name"], message: "Required" },
        ]);

        expect(fields).toEqual({ "items.0.name": ["Required"] });
    });
});
