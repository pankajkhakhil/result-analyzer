const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");

const app = express();
app.use(cors());
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

        // School Code (Column 4, index 3)
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
        let percentage = "0.00";

        // ==========================================
        // 10th CLASS (SECONDARY) SCRAPING LOGIC
        // ==========================================
        if (exam.includes("SEC") || exam.includes("VOC") || exam.includes("PRA")) {
            const marksRow = $(rows[3]);
            const tds = marksRow.find("td");
            
            if (tds.length >= 26) {
                subjects["HINDI"] = parseInt($(tds[3]).text().replace(/[^\d]/g, "")) || 0;
                subjects["ENGLISH"] = parseInt($(tds[7]).text().replace(/[^\d]/g, "")) || 0;
                subjects["SCIENCE"] = parseInt($(tds[11]).text().replace(/[^\d]/g, "")) || 0;
                subjects["SOC.SCIENCE"] = parseInt($(tds[15]).text().replace(/[^\d]/g, "")) || 0;
                subjects["MATHS"] = parseInt($(tds[19]).text().replace(/[^\d]/g, "")) || 0;
                
                grandTotal = parseInt($(tds[24]).text().replace(/[^\d]/g, "")) || 0;
                
                const rawResult = $(tds[26]).text().trim().toUpperCase();
                if (rawResult.includes("1")) resultStatus = "1st Division";
                else if (rawResult.includes("2")) resultStatus = "2nd Division";
                else if (rawResult.includes("3")) resultStatus = "3rd Division";
                else if (rawResult.includes("FAIL")) resultStatus = "FAIL";
                else resultStatus = rawResult;
            }
            
            if (rows.length > 4) {
                const thirdLangRow = $(rows[4]);
                const tL_tds = thirdLangRow.find("td");
                
                if (tL_tds.length >= 5) {
                    const thirdLangName = $(tL_tds[0]).text().replace(/[\u00a0\s]+/g, ' ').trim();
                    const thirdLangMark = parseInt($(tL_tds[4]).text().replace(/[^\d]/g, ""));
                    if (thirdLangName && !isNaN(thirdLangMark)) {
                        subjects[thirdLangName] = thirdLangMark;
                    }
                }
                
                // Percentage directly from cell
                const percText = thirdLangRow.find("td:contains('%')").text();
                if (percText) {
                    percentage = percText.replace(/[^\d.]/g, ""); 
                } else {
                    percentage = ((grandTotal / 600) * 100).toFixed(2); 
                }
            } else {
                percentage = ((grandTotal / 600) * 100).toFixed(2);
            }
        } 
        
        // ==========================================
        // 12th CLASS (SR. SECONDARY) SCRAPING LOGIC
        // ==========================================
        else {
            rows.slice(2).each((i, row) => {
                const cols = $(row).find("td");
                if (cols.length >= 8) {
                    const subName = $(cols[0]).text().replace(/[\u00a0\s]+/g, ' ').trim();
                    const mark = parseInt($(cols[7]).text().replace(/[^\d]/g, ""));

                    if (subName && !isNaN(mark)) subjects[subName] = mark;

                    if (i === 0) {
                        grandTotal = parseInt($(cols[8]).text().replace(/[^\d]/g, "")) || 0;
                        const rawDiv = $(cols[10]).text().replace(/[\u00a0\s]+/g, ' ').trim().toUpperCase();
                        
                        if (rawDiv.includes("1")) resultStatus = "1st Division";
                        else if (rawDiv.includes("2")) resultStatus = "2nd Division";
                        else if (rawDiv.includes("3")) resultStatus = "3rd Division";
                        else if (rawDiv.includes("FAIL")) resultStatus = "FAIL";
                        else resultStatus = rawDiv;
                    }
                }
            });
            
            // 12th ke liye bhi Percentage directly html table element se uthayenge
            const percText = subjectTable.find("td:contains('%')").text();
            if (percText) {
                percentage = percText.replace(/[^\d.]/g, ""); // '%', spaces aur characters hata kar sirf number (e.g. 75.40) bachega
            } else {
                percentage = ((grandTotal / 500) * 100).toFixed(2); // Fallback agar official % load na ho
            }
        }

        return {
            roll: rollNo,
            schoolCode: schoolCode,
            name,
            father,
            subjects,
            total: grandTotal,
            percentage: percentage,
            result: resultStatus
        };
    } catch (e) {
        return null;
    }
}

app.get("/wake", (req, res) => {
  res.send("Server awake");
});

/* ===== API ROUTE & DYNAMIC SCANNER ===== */
app.post("/analyze", async (req, res) => {
    const { year, exam, roll } = req.body;
    const initialRoll = parseInt(roll);

    if (isNaN(initialRoll)) return res.json({ students: [] });

    const initialStudent = await fetchStudent(year, exam, initialRoll);
    
    if (!initialStudent) {
        return res.json({ students: [], summary: {}, top3: [] });
    }

    const targetSchool = initialStudent.schoolCode;
    let students = [initialStudent];

    async function scanDirection(startRoll, step) {
        let keepGoing = true;
        let currentStart = startRoll;
        let fetchedList = [];
        const batchSize = 15; 

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
                    if (s.schoolCode === targetSchool) {
                        fetchedList.push(s);
                    } else {
                        hitOtherSchool = true;
                        break; 
                    }
                }
            }

            if (hitOtherSchool || !foundInBatch) {
                keepGoing = false;
            } else {
                currentStart += (batchSize * step);
            }
        }
        return fetchedList;
    }

    console.log(`Scanning school ${targetSchool} dynamically...`);
    const [backwardStudents, forwardStudents] = await Promise.all([
        scanDirection(initialRoll - 1, -1),
        scanDirection(initialRoll + 1, 1)  
    ]);

    students = [...students, ...backwardStudents, ...forwardStudents];

    let summary = { total: students.length, first: 0, second: 0, third: 0, fail: 0 };
    students.forEach(s => {
        if (s.result.includes("1st")) summary.first++;
        else if (s.result.includes("2nd")) summary.second++;
        else if (s.result.includes("3rd")) summary.third++;
        else if (s.result.includes("FAIL")) summary.fail++;
    });

    const top3 = [...students].sort((a, b) => b.total - a.total).slice(0, 3);

    students.sort((a, b) => parseInt(a.roll) - parseInt(b.roll));
    
    res.json({ students, summary, top3 });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
