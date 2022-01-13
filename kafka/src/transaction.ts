import { assert } from 'console';
import { EventEmitter } from "events";
import fs from 'fs';
import { promises as fsPromises } from 'fs';

/*
 * Простейший механизм для транзакции. Не сохраняет последовательность операций над объектом!! 
 * Но обеспечивает целостность Get запроса на объект.
 */

export class LockTransaction {
    LockWith(filename: string, lock: boolean) {
        if (lock == true) {
            this.Lock(filename);
        }
        else {
            this.Unlock(filename);
        }
    }
    Lock(filename: string) {
        console.log("lock file: " + filename);
        if (this.files[filename] == null) {
            this.files[filename] = 1;
        }
        else {
            this.files[filename] += 1;
        }
    }
    Unlock(filename: string) {
        console.log("unlock file: " + filename);
        assert(this.files[filename] != null, "Unlock non locked file");
        if (this.files[filename] > 1) {
            this.files[filename] -= 1;
        }
        else {
            this.emmiter.emit("unlock", filename);
            delete this.files[filename];
        }
    }
    LockCount(filename: string): number {
        if (this.files[filename] == null) {
            return 0;
        }
        else {
            return this.files[filename];
        }
    }
    emmiter: EventEmitter = new EventEmitter();
    private files: { [filename: string]: number } = {};
};
export let lock = new LockTransaction();

// Удаление файла с локом.
export async function DeleteLockedFile(path: string): Promise<boolean> {
    let lockedOnExecute = lock.LockCount(path) != 0;
    return new Promise<boolean>(async (resolve, reject) => {
        if (lockedOnExecute) {
            let handler = async (filename: string) => {
                if (path === filename) {
                    let deleted = false;
                    if (fs.existsSync(path)) {
                        await fsPromises.unlink(path);
                        deleted = true;
                    }
                    lock.emmiter.removeListener("unlock", handler);
                    resolve(deleted);
                }
            };
            lock.emmiter.addListener("unlock", handler);
        }
        else {
            if (fs.existsSync(path)) {
                await fsPromises.unlink(path);
                resolve(true);
            }
            else {
                resolve(false);
            }

        }
    });
}

export default { LockTransaction, lock, DeleteLockedFile }