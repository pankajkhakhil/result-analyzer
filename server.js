const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const URL = "http://117.239.28.178:8081/OLDRESULT/view_TR.asp";

async function fetchStudent(year, exam, roll) {
    try {
        const form = new URLSearchParams();
        form.append("cmb_year", year);
        form.append("cmb_exam", exam);
        form.append("txt_roll", roll);

        const res = await axios.post(URL, form);
        const $ = cheerio.load(res.data);

        if (!$("td:contains('NAME OF CANDIDATE')").length) return null;

        /* ===== BASIC INFO ===== */
        const headerCell = $("td:contains('NAME OF CANDIDATE')").last();
        const dataRow = headerCell.parent().next();
        const cells = dataRow.find("td");

        // School Code (Column 4, index 3) - Ye hume boundary check karne me kaam aayega
        const schoolCode = $(cells[3]).text().replace(/[\u00a0\s]+/g, '').trim();

        // Roll Number (Column 5, index 4)
        const rollNoText = $(cells[4]).text().replace(/[\u00a0\s]+/g, '').trim();
        const rollNo = rollNoText || roll;

        // Name & Father Name
        const rawHtml = $(cells[5]).html() || "";
        const nameParts = rawHtml.split(/<br\s*\/?>/i);
        const name = nameParts[0] ? cheerio.load(nameParts[0]).text().replace(/[\u00a0\s]+/g, ' ').trim() : "N/A";
        const father = nameParts[1] ? cheerio.load(nameParts[1]).text().replace(/[\u00a0\s]+/g, ' ').trim() : "N/A";

        /* ===== SUBJECTS & RESULT ===== */
        const subjectTable = $("table").last();
        const rows = subjectTable.find("tr");
        
        let subjects = {};
        let grandTotal = 0;
        let resultStatus = "";

        rows.slice(2).each((i, row) => {
            const cols = $(row).find("td");
            if (cols.length >= 8) {
                const subName = $(cols[0]).text().replace(/[\u00a0\s]+/g, ' ').trim();
                const mark = parseInt($(cols[7]).text().replace(/[^\d]/g, ""));

                if (subName && !isNaN(mark)) subjects[subName] = mark;

                if (i === 0) {
                    grandTotal = parseInt($(cols[8]).text().replace(/[^\d]/g, "")) || 0;
                    const rawDiv = $(cols[10]).text().replace(/[\u00a0\s]+/g, ' ').trim();
                    
                    if (rawDiv.includes("1")) resultStatus = "1st Division";
                    else if (rawDiv.includes("2")) resultStatus = "2nd Division";
                    else if (rawDiv.includes("3")) resultStatus = "3rd Division";
                    else if (rawDiv.includes("FAIL")) resultStatus = "FAIL";
                    else resultStatus = rawDiv;
                }
            }
        });

        return {
            roll: rollNo,
            schoolCode: schoolCode, // School code return kar rahe hain
            name,
            father,
            subjects,
            total: grandTotal,
            percentage: ((grandTotal / 500) * 100).toFixed(2),
            result: resultStatus
        };
    } catch (e) {
        return null;
    }
}

/* ===== API ROUTE & DYNAMIC SCANNER ===== */
app.post("/analyze", async (req, res) => {
    const { year, exam, roll } = req.body;
    const initialRoll = parseInt(roll);

    if (isNaN(initialRoll)) return res.json({ students: [] });

    // 1. Sabse pehle user ka diya roll number fetch karo taaki School Code mil sake
    const initialStudent = await fetchStudent(year, exam, initialRoll);
    
    if (!initialStudent) {
        return res.json({ students: [], summary: {}, top3: [] });
    }

    const targetSchool = initialStudent.schoolCode;
    let students = [initialStudent];

    // Helper function: Ek direction me tab tak fetch karega jab tak school na badal jaye
    async function scanDirection(startRoll, step) {
        let keepGoing = true;
        let currentStart = startRoll;
        let fetchedList = [];
        const batchSize = 15; // Ek sath 15 bacho ka data

        while (keepGoing) {
            let batchRolls = [];
            for (let i = 0; i < batchSize; i++) {
                batchRolls.push(currentStart + (i * step));
            }

            const batchResults = await Promise.all(batchRolls.map(r => fetchStudent(year, exam, r)));
            
            let foundInBatch = false;
            let hitOtherSchool = false;

            for (let s of batchResults) {
                if (s) {
                    foundInBatch = true;
                    // Agar school code same hai tabhi list me dalo
                    if (s.schoolCode === targetSchool) {
                        fetchedList.push(s);
                    } else {
                        // Agar dusra school shuru ho gaya, to is direction me aage nahi badhna
                        hitOtherSchool = true;
                        break; 
                    }
                }
            }

            // Agar pura batch khali aaya ya doosra school mil gaya, to loop rok do
            if (hitOtherSchool || !foundInBatch) {
                keepGoing = false;
            } else {
                currentStart += (batchSize * step);
            }
        }
        return fetchedList;
    }

    // 2. Backward (peeche) aur Forward (aage) ek saath scan karo
    console.log(`Scanning school ${targetSchool} dynamically...`);
    const [backwardStudents, forwardStudents] = await Promise.all([
        scanDirection(initialRoll - 1, -1), // Peeche scan karega: -1, -2, -3...
        scanDirection(initialRoll + 1, 1)   // Aage scan karega: +1, +2, +3...
    ]);

    // 3. Sabhi bacho ko ek list me jod do
    students = [...students, ...backwardStudents, ...forwardStudents];

    // 4. Summary Prepare karo
    let summary = { total: students.length, first: 0, second: 0, third: 0, fail: 0 };
    students.forEach(s => {
        if (s.result.includes("1st")) summary.first++;
        else if (s.result.includes("2nd")) summary.second++;
        else if (s.result.includes("3rd")) summary.third++;
        else if (s.result.includes("FAIL")) summary.fail++;
    });

    // 5. Top 3 Performers (Total Marks descending)
    const top3 = [...students].sort((a, b) => b.total - a.total).slice(0, 3);

    // 6. Main list ko Roll Number ke hisaab se Ascending order me sort karo (1, 2, 3...)
    students.sort((a, b) => parseInt(a.roll) - parseInt(b.roll));
    
    res.json({ students, summary, top3 });
});

app.listen(3000, () => console.log("Server running on http://localhost:3000"));