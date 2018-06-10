import { map, filter } from 'lodash';
import uuidv4 from 'uuid/v4';
import mime from 'mime-types';

import { Group, Message, User } from './connectors';
import { sendNotification } from '../notifications';
import { uploadFile, deleteFile, getFileUrl, getSignedFileUrl } from '../files';

// reusable function to check for a user with context
function getAuthenticatedUser(ctx) {
  return ctx.user.then((user) => {
    if (!user) {
      return Promise.reject('Unauthorized');
    }
    return user;
  });
}

export const messageLogic = {
  from(message, args, ctx) {
    if (!ctx.userLoader) {
      return message.getUser({ attributes: ['id', 'username'] });
    }
    return ctx.userLoader.load(message.userId).then(({ id, username }) => ({ id, username }));
  },
  to(message, args, ctx) {
    if (!ctx.groupLoader) {
      return message.getGroup({ attributes: ['id', 'name'] });
    }
    return ctx.groupLoader.load(message.groupId).then(({ id, name }) => ({ id, name }));
  },
  createMessage(_, createMessageInput, ctx) {
    const { text, groupId } = createMessageInput.message;

    return getAuthenticatedUser(ctx)
      .then(user => user.getGroups({ where: { id: groupId } })
        .then((groups) => {
          if (groups.length) {
            return Message.create({
              userId: user.id,
              text,
              groupId,
            }).then((message) => {
              const group = groups[0];
              group.getUsers().then((users) => {
                const userPromises = map(filter(users, usr => usr.id !== user.id), usr => usr.increment('badgeCount'));
                Promise.all(userPromises).then((updatedUsers) => {
                  const registeredUsers = filter(updatedUsers, usr => usr.registrationId);
                  if (registeredUsers.length) {
                    registeredUsers.forEach(({ badgeCount, registrationId }) => sendNotification({
                      to: registrationId,
                      notification: {
                        title: `${user.username} @ ${group.name}`,
                        body: text,
                        sound: 'default', // can use custom sounds -- see https://developer.apple.com/library/content/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/SupportingNotificationsinYourApp.html#//apple_ref/doc/uid/TP40008194-CH4-SW10
                        badge: badgeCount + 1, // badgeCount doesn't get updated in Promise return?!
                        click_action: 'openGroup',
                      },
                      data: {
                        title: `${user.username} @ ${group.name}`,
                        body: text,
                        type: 'MESSAGE_ADDED',
                        group: {
                          id: group.id,
                          name: group.name,
                        },
                      },
                      priority: 'high', // will wake sleeping device
                    }));
                  }
                });
              });

              return message;
            });
          }
          return Promise.reject('Unauthorized');
        }));
  },
};

export const groupLogic = {
  users(group) {
    return group.getUsers({ attributes: ['id', 'username'] });
  },
  messages(group, { messageConnection = {} }) {
    const { first, last, before, after } = messageConnection;

    // base query -- get messages from the right group
    const where = { groupId: group.id };

    // because we return messages from newest -> oldest
    // before actually means newer (date > cursor)
    // after actually means older (date < cursor)

    if (before) {
      // convert base-64 to utf8 iso date and use in Date constructor
      where.id = { $gt: Buffer.from(before, 'base64').toString() };
    }

    if (after) {
      where.id = { $lt: Buffer.from(after, 'base64').toString() };
    }

    return Message.findAll({
      where,
      order: [['id', 'DESC']],
      limit: first || last,
    }).then((messages) => {
      const edges = messages.map(message => ({
        cursor: Buffer.from(message.id.toString()).toString('base64'), // convert createdAt to cursor
        node: message, // the node is the message itself
      }));

      return {
        edges,
        pageInfo: {
          hasNextPage() {
            if (messages.length < (last || first)) {
              return Promise.resolve(false);
            }

            return Message.findOne({
              where: {
                groupId: group.id,
                id: {
                  [before ? '$gt' : '$lt']: messages[messages.length - 1].id,
                },
              },
              order: [['id', 'DESC']],
            }).then(message => !!message);
          },
          hasPreviousPage() {
            return Message.findOne({
              where: {
                groupId: group.id,
                id: where.id,
              },
              order: [['id']],
            }).then(message => !!message);
          },
        },
      };
    });
  },
  lastRead(group, args, ctx) {
    return getAuthenticatedUser(ctx)
      .then(user => user.getLastRead({ where: { groupId: group.id } }))
      .then((lastRead) => {
        if (lastRead.length) {
          return lastRead[0];
        }

        return null;
      });
  },
  unreadCount(group, args, ctx) {
    return getAuthenticatedUser(ctx)
      .then(user => user.getLastRead({ where: { groupId: group.id } }))
      .then((lastRead) => {
        if (!lastRead.length) {
          return Message.count({ where: { groupId: group.id } });
        }

        return Message.count({
          where: {
            groupId: group.id,
            createdAt: { $gt: lastRead[0].createdAt },
          },
        });
      });
  },
  icon(group) {
    if (group.icon) {
      console.log('getSignedFileUrl for group', group.icon);
      return getSignedFileUrl({ file: group.icon, options: { Expires: 60 * 60 } });
    }

    return null;
  },
  query(_, { id }, ctx) {
    return getAuthenticatedUser(ctx).then(user => Group.findOne({
      where: { id },
      include: [{
        model: User,
        where: { id: user.id },
      }],
    }));
  },
  createGroup(_, createGroupInput, ctx) {
    const { name, userIds, icon } = createGroupInput.group;

    return getAuthenticatedUser(ctx)
      .then(user => user.getFriends({ where: { id: { $in: userIds } } })
        .then((friends) => { // eslint-disable-line arrow-body-style
          return Group.create({
            name,
          }).then((group) => { // eslint-disable-line arrow-body-style
            return group.addUsers([user, ...friends]).then(() => {
              group.users = [user, ...friends];

              if (icon) {
                return uploadFile({
                  file: icon.path,
                  options: {
                    name: `${uuidv4()}.${mime.extension(icon.type)}`,
                    acl: 'private',
                  },
                })
                  .then(data => group.update({ icon: data.Key }));
              }

              return group;
            });
          });
        }));
  },
  deleteGroup(_, { id }, ctx) {
    return getAuthenticatedUser(ctx).then((user) => { // eslint-disable-line arrow-body-style
      return Group.findOne({
        where: { id },
        include: [{
          model: User,
          where: { id: user.id },
        }],
      }).then(group => group.getUsers()
        .then(users => group.removeUsers(users))
        .then(() => Message.destroy({ where: { groupId: group.id } }))
        .then(() => {
          if (group.icon) {
            return deleteFile(group.icon);
          }
          return group;
        })
        .then(() => group.destroy()));
    });
  },
  leaveGroup(_, { id }, ctx) {
    return getAuthenticatedUser(ctx).then((user) => {
      if (!user) {
        return Promise.reject('Unauthorized');
      }

      return Group.findOne({
        where: { id },
        include: [{
          model: User,
          where: { id: user.id },
        }],
      }).then((group) => {
        if (!group) {
          Promise.reject('No group found');
        }

        return group.removeUser(user.id)
          .then(() => group.getUsers())
          .then((users) => {
            // if the last user is leaving, remove the group
            if (!users.length) {
              group.destroy();
            }
            return { id };
          });
      });
    });
  },
  updateGroup(_, updateGroupInput, ctx) {
    const { id, name, lastRead, icon } = updateGroupInput.group;

    return getAuthenticatedUser(ctx).then((user) => { // eslint-disable-line arrow-body-style
      return Group.findOne({
        where: { id },
        include: [{
          model: User,
          where: { id: user.id },
        }],
      }).then((group) => {
        let lastReadPromise = (options = {}) => Promise.resolve(options);
        if (lastRead) {
          lastReadPromise = (options = {}) => user.getLastRead({ where: { groupId: id } })
            .then(oldLastRead => user.removeLastRead(oldLastRead))
            .then(user.addLastRead(lastRead))
            .then(() => options);
        }

        let iconPromise = options => Promise.resolve(options);
        if (icon) {
          iconPromise = options => uploadFile({
            file: icon.path,
            options: {
              name: `${uuidv4()}.${mime.extension(icon.type)}`,
              acl: 'private', // only group's users should have access
            },
          })
            .then((data) => {
              if (group.icon) {
                return deleteFile(group.icon).then(() => data);
              }

              return data;
            })
            .then(data => Object.assign(options, { icon: data.Key }));
        }

        let namePromise = options => Promise.resolve(options);
        if (name) {
          namePromise = options => Object.assign(options, { name });
        }

        return lastReadPromise()
          .then(opts => iconPromise(opts))
          .then(opts => namePromise(opts))
          .then(opts => group.update(opts));
      });
    });
  },
};

export const userLogic = {
  avatar(user, args, ctx) {
    return user.avatar ? getFileUrl(user.avatar) : null;
  },
  email(user, args, ctx) {
    return getAuthenticatedUser(ctx).then((currentUser) => {
      if (currentUser.id === user.id) {
        return currentUser.email;
      }

      return Promise.reject('Unauthorized');
    });
  },
  friends(user, args, ctx) {
    return getAuthenticatedUser(ctx).then((currentUser) => {
      if (currentUser.id !== user.id) {
        return Promise.reject('Unauthorized');
      }

      return user.getFriends({ attributes: ['id', 'username'] });
    });
  },
  groups(user, args, ctx) {
    return getAuthenticatedUser(ctx).then((currentUser) => {
      if (currentUser.id !== user.id) {
        return Promise.reject('Unauthorized');
      }

      return user.getGroups();
    });
  },
  jwt(user) {
    return Promise.resolve(user.jwt);
  },
  messages(user, args, ctx) {
    return getAuthenticatedUser(ctx).then((currentUser) => {
      if (currentUser.id !== user.id) {
        return Promise.reject('Unauthorized');
      }

      return Message.findAll({
        where: { userId: user.id },
        order: [['createdAt', 'DESC']],
      });
    });
  },
  registrationId(user, args, ctx) {
    return getAuthenticatedUser(ctx).then((currentUser) => {
      if (currentUser.id === user.id) {
        return currentUser.registrationId;
      }

      return Promise.reject('Unauthorized');
    });
  },
  query(_, args, ctx) {
    return getAuthenticatedUser(ctx).then((user) => {
      if (user.id === args.id || user.email === args.email) {
        return user;
      }

      return Promise.reject('Unauthorized');
    });
  },
  updateUser(_, updateUserInput, ctx) {
    const { registrationId, badgeCount, avatar, username } = updateUserInput.user;

    return getAuthenticatedUser(ctx).then((user) => { // eslint-disable-line arrow-body-style
      const options = {};

      if (registrationId || registrationId === null) {
        options.registrationId = registrationId;
      }

      if (badgeCount || badgeCount === 0) {
        options.badgeCount = badgeCount;
      }

      if (username) {
        options.username = username;
      }

      if (avatar) {
        return uploadFile({
          file: avatar.path,
          options: {
            name: `${uuidv4()}.${mime.extension(avatar.type)}`,
          },
        })
          .then((data) => {
            if (user.avatar) {
              return deleteFile(user.avatar).then(() => data);
            }

            return data;
          })
          .then(data => user.update(Object.assign(options, { avatar: data.Key })));
      }

      return user.update(options);
    });
  },
};

export const subscriptionLogic = {
  groupAdded(baseParams, args, ctx) {
    return getAuthenticatedUser(ctx)
      .then((user) => {
        if (user.id !== args.userId) {
          return Promise.reject('Unauthorized');
        }

        baseParams.context = ctx;
        return baseParams;
      });
  },
  messageAdded(baseParams, args, ctx) {
    return getAuthenticatedUser(ctx)
      .then(user => user.getGroups({ where: { id: { $in: args.groupIds } }, attributes: ['id'] })
        .then((groups) => {
        // user attempted to subscribe to some groups without access
          if (args.groupIds.length > groups.length) {
            return Promise.reject('Unauthorized');
          }

          baseParams.context = ctx;
          return baseParams;
        }));
  },
};
