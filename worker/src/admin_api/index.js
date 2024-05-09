import { Hono } from 'hono'
import { Jwt } from 'hono/utils/jwt'
import { sendAdminInternalMail, getJsonSetting, saveSetting } from '../utils'
import { newAddress, handleListQuery } from '../common'
import { CONSTANTS } from '../constants'
import cleanup_api from './cleanup_api'
import admin_user_api from './admin_user_api'

const api = new Hono()

api.get('/admin/address', async (c) => {
    const { limit, offset, query } = c.req.query();
    if (query) {
        return await handleListQuery(c,
            `SELECT a.*,`
            + ` (SELECT COUNT(*) FROM raw_mails WHERE address = a.name) AS mail_count,`
            + ` (SELECT COUNT(*) FROM sendbox WHERE address = a.name) AS send_count`
            + ` FROM address a`
            + ` where name like ?`,
            `SELECT count(*) as count FROM address where name like ?`,
            [`%${query}%`], limit, offset
        );
    }
    return await handleListQuery(c,
        `SELECT a.*,`
        + ` (SELECT COUNT(*) FROM raw_mails WHERE address = a.name) AS mail_count,`
        + ` (SELECT COUNT(*) FROM sendbox WHERE address = a.name) AS send_count`
        + ` FROM address a`,
        `SELECT count(*) as count FROM address`,
        [], limit, offset
    );
})

api.post('/admin/new_address', async (c) => {
    let { name, domain, enablePrefix } = await c.req.json();
    if (!name) {
        return c.text("Please provide a name", 400)
    }
    return newAddress(c, name, domain, enablePrefix);
})

api.delete('/admin/delete_address/:id', async (c) => {
    const { id } = c.req.param();
    const { success } = await c.env.DB.prepare(
        `DELETE FROM address WHERE id = ? `
    ).bind(id).run();
    if (!success) {
        return c.text("Failed to delete address", 500)
    }
    const { success: mailSuccess } = await c.env.DB.prepare(
        `DELETE FROM raw_mails WHERE address IN`
        + ` (select name from address where id = ?) `
    ).bind(id).run();
    if (!mailSuccess) {
        return c.text("Failed to delete mails", 500)
    }
    const { success: sendAccess } = await c.env.DB.prepare(
        `DELETE FROM address_sender WHERE address IN`
        + ` (select name from address where id = ?) `
    ).bind(id).run();
    const { success: usersAddressSuccess } = await c.env.DB.prepare(
        `DELETE FROM users_address WHERE address_id = ?`
    ).bind(id).run();
    return c.json({
        success: success && mailSuccess && sendAccess && usersAddressSuccess
    })
})

api.get('/admin/show_password/:id', async (c) => {
    const { id } = c.req.param();
    const name = await c.env.DB.prepare(
        `SELECT name FROM address WHERE id = ? `
    ).bind(id).first("name");
    const jwt = await Jwt.sign({
        address: name,
        address_id: id
    }, c.env.JWT_SECRET, "HS256")
    return c.json({
        jwt: jwt
    })
})

api.get('/admin/mails', async (c) => {
    const { address, limit, offset, keyword } = c.req.query();
    if (address && keyword) {
        return await handleListQuery(c,
            `SELECT * FROM raw_mails where address = ? and raw like ? `,
            `SELECT count(*) as count FROM raw_mails where address = ? and raw like ? `,
            [address, `%${keyword}%`], limit, offset
        );
    } else if (keyword) {
        return await handleListQuery(c,
            `SELECT * FROM raw_mails where raw like ? `,
            `SELECT count(*) as count FROM raw_mails where raw like ? `,
            [`%${keyword}%`], limit, offset
        );
    } else if (address) {
        return await handleListQuery(c,
            `SELECT * FROM raw_mails where address = ? `,
            `SELECT count(*) as count FROM raw_mails where address = ? `,
            [address], limit, offset
        );
    } else {
        return await handleListQuery(c,
            `SELECT * FROM raw_mails `,
            `SELECT count(*) as count FROM raw_mails `,
            [], limit, offset
        );
    }
});

api.get('/admin/mails_unknow', async (c) => {
    const { limit, offset } = c.req.query();
    return await handleListQuery(c,
        `SELECT * FROM raw_mails where address NOT IN (select name from address) `,
        `SELECT count(*) as count FROM raw_mails`
        + ` where address NOT IN (select name from address) `,
        [], limit, offset
    );
});

api.get('/admin/address_sender', async (c) => {
    const { address, limit, offset } = c.req.query();
    if (address) {
        return await handleListQuery(c,
            `SELECT * FROM address_sender where address = ? `,
            `SELECT count(*) as count FROM address_sender where address = ? `,
            [address], limit, offset
        );
    }
    return await handleListQuery(c,
        `SELECT * FROM address_sender `,
        `SELECT count(*) as count FROM address_sender `,
        [], limit, offset
    );
})

api.post('/admin/address_sender', async (c) => {
    let { address, address_id, balance, enabled } = await c.req.json();
    if (!address_id) {
        return c.text("Invalid address_id", 400)
    }
    enabled = enabled ? 1 : 0;
    const { success } = await c.env.DB.prepare(
        `UPDATE address_sender SET enabled = ?, balance = ? WHERE id = ? `
    ).bind(enabled, balance, address_id).run();
    if (!success) {
        return c.text("Failed to update address sender", 500)
    }
    await sendAdminInternalMail(
        c, address, "Account Send Access Updated",
        `You send access has been ${enabled ? "enabled" : "disabled"}, balance: ${balance}`
    );
    return c.json({
        success: success
    })
})

api.get('/admin/sendbox', async (c) => {
    const { address, limit, offset } = c.req.query();
    if (address) {
        return await handleListQuery(c,
            `SELECT * FROM sendbox where address = ? `,
            `SELECT count(*) as count FROM sendbox where address = ? `,
            [address], limit, offset
        );
    }
    return await handleListQuery(c,
        `SELECT * FROM sendbox `,
        `SELECT count(*) as count FROM sendbox `,
        [], limit, offset
    );
})

api.get('/admin/statistics', async (c) => {
    const { count: mailCount } = await c.env.DB.prepare(`
            SELECT count(*) as count FROM raw_mails`
    ).first();
    const { count: addressCount } = await c.env.DB.prepare(`
            SELECT count(*) as count FROM address`
    ).first();
    const { count: activeUserCount7days } = await c.env.DB.prepare(`
            SELECT count(*) as count FROM address where updated_at > datetime('now', '-7 day')`
    ).first();
    const { count: sendMailCount } = await c.env.DB.prepare(`
            SELECT count(*) as count FROM sendbox`
    ).first();
    return c.json({
        mailCount: mailCount,
        userCount: addressCount,
        activeUserCount7days: activeUserCount7days,
        sendMailCount: sendMailCount
    })
});

api.get('/admin/account_settings', async (c) => {
    try {
        /** @type {Array<string>|undefined|null} */
        const blockList = await getJsonSetting(c, CONSTANTS.ADDRESS_BLOCK_LIST_KEY);
        /** @type {Array<string>|undefined|null} */
        const sendBlockList = await getJsonSetting(c, CONSTANTS.SEND_BLOCK_LIST_KEY);
        return c.json({
            blockList: blockList || [],
            sendBlockList: sendBlockList || []
        })
    } catch (error) {
        console.error(error);
        return c.json({})
    }
})

api.post('/admin/account_settings', async (c) => {
    /** @type {{ blockList: Array<string>, sendBlockList: Array<string> }} */
    const { blockList, sendBlockList } = await c.req.json();
    if (!blockList || !sendBlockList) {
        return c.text("Invalid blockList or sendBlockList", 400)
    }
    await saveSetting(
        c, CONSTANTS.ADDRESS_BLOCK_LIST_KEY,
        JSON.stringify(blockList)
    );
    await saveSetting(
        c, CONSTANTS.SEND_BLOCK_LIST_KEY,
        JSON.stringify(sendBlockList)
    );
    return c.json({
        success: true
    })
})

api.post('/admin/cleanup', cleanup_api.cleanup)
api.get('/admin/auto_cleanup', cleanup_api.getCleanup)
api.post('/admin/auto_cleanup', cleanup_api.saveCleanup)
api.get('/admin/user_settings', admin_user_api.getSetting)
api.post('/admin/user_settings', admin_user_api.saveSetting)
api.get('/admin/users', admin_user_api.getUsers)
api.delete('/admin/users/:user_id', admin_user_api.deleteUser)
api.post('/admin/users', admin_user_api.createUser)
api.post('/admin/users/:user_id/reset_password', admin_user_api.resetPassword)

export { api }
